import { randomUUID } from "node:crypto"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function getEditor(): string {
  return process.env.EDITOR || process.env.VISUAL || "vi"
}

/** The slice of the OpenTUI renderer this module needs — narrow so the edit flow can be
 *  driven by a stub in tests without a terminal. */
export interface Suspendable {
  suspend(): void
  resume(): void
}

/**
 * Write `text` to a private temp file, hand it to $EDITOR with the TUI suspended, and return
 * what the editor left behind (monq's suspend/spawn/resume pattern).
 *
 * The file is 0600 and unlinked the moment the editor exits — the narrow exception to
 * nfr/003's "payloads never touch disk", which is why the read happens inside the `try` and
 * the unlink inside the `finally`: an editor that crashes must not leave a decoded
 * production payload in /tmp.
 */
async function throughEditor(renderer: Suspendable, text: string, name: string): Promise<string> {
  // Exclusive create, and a random suffix: the path is in a world-writable directory, so
  // a predictable name is a symlink someone else can plant. "wx" refuses to follow one.
  const path = join(tmpdir(), `topiq-${process.pid}-${randomUUID().slice(0, 8)}-${name}`)
  await writeFile(path, text, { mode: 0o600, flag: "wx" })
  renderer.suspend()
  try {
    const proc = Bun.spawn([getEditor(), path], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited
    return await readFile(path, "utf8")
  } finally {
    renderer.resume()
    await unlink(path).catch(() => {})
  }
}

/** Open text in $EDITOR for viewing; whatever the user typed is discarded (spec 008). */
export async function viewInEditor(
  renderer: Suspendable,
  text: string,
  name: string,
): Promise<void> {
  await throughEditor(renderer, text, name)
}

/** Open text in $EDITOR and return the saved buffer (spec 014). Identical plumbing to
 *  `viewInEditor` on purpose — the temp file's mode and lifetime are decided once. */
export async function editInEditor(
  renderer: Suspendable,
  text: string,
  name: string,
): Promise<string> {
  return await throughEditor(renderer, text, name)
}
