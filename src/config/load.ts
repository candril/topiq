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

let loadCounter = 0

export async function loadConfig(path: string = configPath()): Promise<ClusterProfile[]> {
  const file = resolve(path)
  if (!(await Bun.file(file).exists())) {
    throw new ConfigError(
      `${path}: not found — create it (see config.example.toml) or point TOPIQ_CONFIG at it`,
    )
  }
  const raw = await importToml(file, path)
  return parseConfig(raw, path).map(expandHome)
}

async function importToml(file: string, displayPath: string): Promise<unknown> {
  try {
    // Query defeats Bun's module cache so an edited config reloads within one process.
    // Monotonic counter, not Date.now(): two loads in the same millisecond would share a
    // query string and hit Bun's module cache, returning stale config.
    const module = await import(`${file}?${++loadCounter}`, { with: { type: "toml" } })
    return module.default
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ConfigError(`${displayPath}: invalid TOML — ${detail}`)
  }
}
