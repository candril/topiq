import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ClusterProfile } from "@/config/schema.ts"
import type { TopicSummary } from "@/types.ts"

// The topic listing changes on the timescale of a deployment, not of a keystroke, so it is
// remembered between runs and the list paints from disk while the fresh one is fetched
// (spec 006). Only names and partition counts live here: watermarks are the part that
// changes constantly, and no message ever touches the disk (nfr/003).

/** Beyond this a remembered listing is thrown away rather than shown — a cluster you open
 *  twice a year should not flash a year-old list before correcting itself. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface CacheFile {
  /** The brokers the listing came from: a repointed profile keeps its name but not its
   *  topics, and serving the old ones would be a lie about a different cluster. */
  brokers: string[]
  fetchedAt: number
  topics: TopicSummary[]
}

function cacheDir(): string {
  const xdg = process.env["XDG_CACHE_HOME"]
  return join(xdg && xdg !== "" ? xdg : join(homedir(), ".cache"), "topiq", "topics")
}

/** Profile names come from TOML keys, so they can carry anything a key can. */
function cacheFile(cluster: string): string {
  return join(cacheDir(), `${cluster.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
}

function isSummary(value: unknown): value is TopicSummary {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const t = value as Record<string, unknown>
  return typeof t["name"] === "string" && typeof t["partitionCount"] === "number"
}

/** The remembered listing, or null on a miss, a stale or unreadable file, or a profile
 *  that now points somewhere else. A cache is an optimisation: every failure here is a
 *  miss, never an error the user has to see. */
export function readTopicCache(profile: ClusterProfile, now = Date.now()): TopicSummary[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFile(profile.name), "utf8"))
    if (typeof parsed !== "object" || parsed === null) {
      return null
    }
    const file = parsed as Partial<CacheFile>
    if (
      !Array.isArray(file.topics) ||
      !Array.isArray(file.brokers) ||
      typeof file.fetchedAt !== "number" ||
      now - file.fetchedAt > MAX_AGE_MS ||
      file.brokers.join(",") !== profile.brokers.join(",")
    ) {
      return null
    }
    return file.topics.every(isSummary) ? file.topics : null
  } catch {
    return null
  }
}

/** Best effort: a cluster whose cache cannot be written still works, just without the
 *  instant first paint. */
export function writeTopicCache(
  profile: ClusterProfile,
  topics: TopicSummary[],
  now = Date.now(),
): void {
  const file: CacheFile = { brokers: profile.brokers, fetchedAt: now, topics }
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 })
    // Rename over the old file so a crash mid-write cannot leave a half-written listing
    // that the next launch would have to parse.
    const target = cacheFile(profile.name)
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(file), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, target)
  } catch {
    // Ignored on purpose — see the doc comment.
  }
}
