// A compiled binary injects TOPIQ_VERSION via `bun build --define` because package.json
// isn't shipped with it; under `bun run` the file is right there, so read it.
declare const TOPIQ_VERSION: string

async function readPackageVersion(): Promise<string> {
  try {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      version?: string
    }
    return pkg.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

export const version: string =
  typeof TOPIQ_VERSION !== "undefined" ? TOPIQ_VERSION : await readPackageVersion()
