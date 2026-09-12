// Read and parse the TOML config file (spec 002); validation lives in schema.ts.

import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { ConfigError, parseConfig, type ClusterProfile } from "./schema.ts"

export function configPath(): string {
  return process.env["TOPIQ_CONFIG"] || join(homedir(), ".config", "topiq", "config.toml")
}

/** `~/…` in ca_cert works like the shell would — the value is hand-typed into TOML. */
function expandHome(profile: ClusterProfile): ClusterProfile {
  if (profile.caCert?.startsWith("~/")) {
    return { ...profile, caCert: join(homedir(), profile.caCert.slice(2)) }
  }
  return profile
}

export async function loadConfig(path: string = configPath()): Promise<ClusterProfile[]> {
  const file = resolve(path)
  if (!(await Bun.file(file).exists())) {
    throw new ConfigError(
      `${path}: not found — create it (see config.example.toml) or point TOPIQ_CONFIG at it`,
    )
  }
  const raw = await parseToml(file, path)
  return parseConfig(raw, path).map(expandHome)
}

/**
 * Parsed from the file's text rather than imported as a module, so there is no module
 * cache to defeat and an edited config re-reads within one process for free.
 *
 * This used to be a dynamic import with a counter in the query string to bust that cache.
 * Bun 1.4 stopped resolving a query-suffixed file specifier, which made every config load
 * throw "Cannot find module …?1", so the tool could not read any config at all.
 */
async function parseToml(file: string, displayPath: string): Promise<unknown> {
  try {
    return Bun.TOML.parse(await Bun.file(file).text())
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ConfigError(`${displayPath}: invalid TOML — ${detail}`)
  }
}
