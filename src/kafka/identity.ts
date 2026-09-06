import { hostname, userInfo } from "node:os"
import { EPHEMERAL_GROUP_PREFIX } from "./groups.ts"

// Who this process is, as a broker sees it (spec 029). A shared cluster's request log,
// quota accounting and lag dashboards key on client.id and group id; "topiq" alone tells
// an admin what connected but never whom to ask.

export interface Identity {
  user: string
  host: string
}

/** Kafka accepts any string for client.id and group.id, but both end up in metric names
 *  and log lines that other tools tokenise on whitespace and punctuation — keep the user
 *  and host to what those survive. */
function safe(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned === "" ? "unknown" : cleaned
}

export function clientId(id: Identity): string {
  return `topiq/${safe(id.user)}@${safe(id.host)}`
}

/** `topiq-read-<user>-<random>`: the prefix is what [017]'s group list filters on, the
 *  user is what makes a stray group attributable, the suffix is what keeps two windows of
 *  one user apart. */
export function ephemeralGroupId(id: Identity, random: () => number = Math.random): string {
  const suffix = random().toString(36).slice(2, 10).padEnd(8, "0")
  return `${EPHEMERAL_GROUP_PREFIX}${safe(id.user)}-${suffix}`
}

/** The running process's identity. `userInfo()` throws on a uid with no passwd entry
 *  (containers, some CI runners); the environment is the fallback, not a crash. */
export function processIdentity(): Identity {
  const user = ((): string => {
    try {
      return userInfo().username
    } catch {
      return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown"
    }
  })()
  return { user, host: hostname() }
}
