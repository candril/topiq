// The only module that touches a secret (nfr/003): run the profile's password_cmd,
// return trimmed stdout. Never log, never persist.

/** Mask anything token-shaped so a failing az/op command stays diagnosable without leaking. */
function redact(text: string): string {
  return text.replace(/[A-Za-z0-9+/=_-]{20,}/g, "[redacted]")
}

export async function fetchSecret(passwordCmd: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", passwordCmd], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`password_cmd failed (exit ${exitCode}): ${redact(stderr.trim())}`)
  }
  const secret = stdout.trim()
  if (!secret) {
    throw new Error("password_cmd produced no output")
  }
  return secret
}
