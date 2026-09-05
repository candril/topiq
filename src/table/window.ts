import type { FetchRange, PartitionStart } from "@/kafka/range.ts"
import type { DecodedMessage, PartitionMeta } from "@/types.ts"

// Window shaping for the message table (specs 007/009): ordering, latest-N trimming and
// the header summaries. All offset math is bigint (nfr/006).

/** The bounded-buffer contract (spec 012): also the consume `limit`, so the broker stops
 *  sending instead of the UI dropping rows it already paid to decode. */
/**
 * Ceiling on a window, matching what Redpanda Console offers. The default window is far
 * smaller (see `initialMessagesState`) — this is the most `n` may ask for.
 *
 * Measured at 10k synthetic rows: flatten 11ms, column inference 4ms, filter 2ms, sort
 * 2ms, ~24MB heap. The binding cost at this size is the network fetch, not the local
 * work, which is why the cap is generous and the *default* is small.
 */
export const WINDOW_CAP = 10_000

/** Partitions have no global order — timestamp is the only cross-partition axis, with
 *  partition/offset as a deterministic tiebreak. */
export function sortWindow(messages: readonly DecodedMessage[]): DecodedMessage[] {
  return [...messages].sort(
    (a, b) =>
      a.timestamp.getTime() - b.timestamp.getTime() ||
      a.partition - b.partition ||
      (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0),
  )
}

/** latestN over-fetches per partition (spec 009): trim the sorted window to the newest n. */
export function trimLatestN(sorted: readonly DecodedMessage[], n: number): DecodedMessage[] {
  return sorted.length <= n ? [...sorted] : sorted.slice(sorted.length - n)
}

/** UTC, second precision plus millis — Kafka timestamps are epoch millis, and hiding the
 *  millis makes same-second messages look identical. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "")
}

export function rangeSummary(range: FetchRange): string {
  switch (range.kind) {
    case "beginning":
      return "beginning"
    case "end":
      return "end"
    case "offset":
      return `offset ≥ ${range.offset}`
    case "latestN":
      return `latest ${range.n}`
    case "timestamp":
      return `since ${formatTimestamp(range.timestamp)} UTC`
  }
}

/** Total messages the resolved starts will read — bigint, may exceed the cap. */
export function plannedCount(
  starts: readonly PartitionStart[],
  partitions: readonly PartitionMeta[],
): bigint {
  const highs = new Map(partitions.map((p) => [p.id, p.high]))
  return starts.reduce((sum, s) => {
    const high = highs.get(s.partition)
    if (s.offset === null || high === undefined || high <= s.offset) {
      return sum
    }
    return sum + (high - s.offset)
  }, 0n)
}

export function resolvedSummary(
  starts: readonly PartitionStart[],
  partitions: readonly PartitionMeta[],
): string {
  const highs = new Map(partitions.map((p) => [p.id, p.high]))
  const active = starts.filter((s) => s.offset !== null)
  if (active.length === 0) {
    return "empty window"
  }
  if (active.length <= 3) {
    return active
      .map((s) => `p${s.partition} ${s.offset}‥${highs.get(s.partition) ?? "?"}`)
      .join(" · ")
  }
  return `${active.length}/${partitions.length} parts · ≈${plannedCount(starts, partitions)} msgs`
}

export type PromptMode = "offset" | "timestamp" | "latestN"

export type ParsedInput = { range: FetchRange } | { error: string }

export function parseRangeInput(mode: PromptMode, input: string): ParsedInput {
  const text = input.trim()
  switch (mode) {
    case "offset":
      if (!/^\d+$/.test(text)) {
        return { error: `offset: "${text}" is not a non-negative integer` }
      }
      return { range: { kind: "offset", offset: BigInt(text) } }
    case "latestN": {
      if (!/^\d+$/.test(text) || text === "0") {
        return { error: `latest: "${text}" is not a positive integer` }
      }
      const n = Number(text)
      if (n > WINDOW_CAP) {
        return { error: `latest: ${n} exceeds the ${WINDOW_CAP}-row window cap` }
      }
      return { range: { kind: "latestN", n } }
    }
    case "timestamp": {
      // Bare digits read as epoch millis; anything else goes through Date.parse (ISO).
      const millis = /^\d{12,}$/.test(text) ? Number(text) : Date.parse(text)
      if (Number.isNaN(millis)) {
        return { error: `timestamp: "${text}" is neither ISO 8601 nor epoch millis` }
      }
      return { range: { kind: "timestamp", timestamp: new Date(millis) } }
    }
  }
}
