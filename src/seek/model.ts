import type { FetchRange, PartitionStart } from "@/kafka/range.ts"
import type { WriteAction } from "@/safety/gate.ts"
// One definition of what an offset or a timestamp looks like when typed: the seek bar and
// the fetch prompt accept exactly the same text, so they parse it with the same function
// (spec 009). `window.ts` is pure — no renderer comes in with it.
import { parseRangeInput } from "@/table/window.ts"
import type { PartitionOffset } from "@/types.ts"

// Consumer-group offset seek (spec 018), the pure half: what a target is, where it lands
// per partition, and what the confirm dialog and the post-write report say. No client and
// no React — the whole decision runs under `bun test` against plain values.
//
// Every offset here is bigint end to end (nfr/006). An offset that went through Number
// would be wrong past 2^53 in the direction that silently rewinds a group.

export type SeekTargetKind = "beginning" | "end" | "offset" | "timestamp"

export interface SeekTarget {
  kind: SeekTargetKind
  label: string
  /** Needs a typed value before it can be resolved. */
  needsValue: boolean
  /** Placeholder for the input, so the accepted forms are visible while typing. */
  placeholder: string
}

export const SEEK_TARGETS: readonly SeekTarget[] = [
  { kind: "beginning", label: "beginning", needsValue: false, placeholder: "" },
  { kind: "end", label: "end", needsValue: false, placeholder: "" },
  { kind: "offset", label: "offset", needsValue: true, placeholder: "absolute offset, e.g. 4711" },
  {
    kind: "timestamp",
    label: "timestamp",
    needsValue: true,
    placeholder: "ISO 8601 or epoch millis",
  },
]

export type ParsedTarget = { range: FetchRange } | { error: string }

/** The typed target as a `FetchRange`, so the seam resolves a seek exactly the way it
 *  resolves a read window — one implementation of "where does `beginning` start". */
export function seekRange(kind: SeekTargetKind, value: string): ParsedTarget {
  switch (kind) {
    case "beginning":
      return { range: { kind: "beginning" } }
    case "end":
      return { range: { kind: "end" } }
    case "offset":
    case "timestamp":
      return parseRangeInput(kind, value)
  }
}

export function seekTargetLabel(range: FetchRange): string {
  switch (range.kind) {
    case "beginning":
      return "beginning"
    case "end":
      return "end"
    case "offset":
      return `offset ${range.offset}`
    case "timestamp":
      return `timestamp ${range.timestamp.toISOString()}`
    case "latestN":
      return `latest ${range.n}`
  }
}

/** One partition's move. `before === null` is "never committed" and `after === null` is
 *  "this partition is not being written" — a timestamp with nothing at or after it, which
 *  leaves the committed offset alone rather than falling back to the log start. */
export interface SeekRow {
  partition: number
  before: bigint | null
  after: bigint | null
}

export function seekRows(
  before: readonly PartitionOffset[],
  after: readonly PartitionStart[],
): SeekRow[] {
  const target = new Map(after.map((s) => [s.partition, s.offset]))
  const ids = new Set([...before.map((o) => o.partition), ...after.map((s) => s.partition)])
  return [...ids]
    .sort((a, b) => a - b)
    .map((partition) => ({
      partition,
      before: before.find((o) => o.partition === partition)?.committed ?? null,
      after: target.get(partition) ?? null,
    }))
}

/** Partitions the write actually moves. A target that resolves to where the group already
 *  is moves nothing, and the gate then refuses with "nothing to seek" rather than opening
 *  a dialog for a no-op. */
export function movedRows(rows: readonly SeekRow[]): SeekRow[] {
  return rows.filter((r) => r.after !== null && r.after !== r.before)
}

function offsetCell(offset: bigint | null): string {
  return offset === null ? "—" : offset.toString()
}

/** "p3  1234 → 5678". `—` on the left is "never committed", on the right "not written". */
export function seekRowLabel(row: SeekRow): string {
  return `p${row.partition} ${offsetCell(row.before)} → ${offsetCell(row.after)}`
}

// Past this the dialog would push its own hint off a short terminal, so the tail is stated
// as a count instead of dropped silently (nfr/004).
const MAX_LISTED_PARTITIONS = 8

/** The per-partition before → after block of the confirm dialog (spec 018 P1). */
export function seekPreviewLines(rows: readonly SeekRow[]): string[] {
  const moved = movedRows(rows)
  const listed = moved.slice(0, MAX_LISTED_PARTITIONS).map(seekRowLabel)
  if (moved.length > listed.length) {
    listed.push(`+${moved.length - listed.length} more partitions`)
  }
  const untouched = rows.length - moved.length
  if (untouched > 0) {
    listed.push(`${untouched} unchanged`)
  }
  return listed
}

export function seekAction(
  groupId: string,
  topic: string,
  range: FetchRange,
  rows: readonly SeekRow[],
): WriteAction {
  return {
    kind: "seek",
    group: groupId,
    topic,
    count: movedRows(rows).length,
    to: seekTargetLabel(range),
    moves: seekPreviewLines(rows),
  }
}

export interface SeekResult {
  message: string
  /** False when the broker's committed offsets do not match what was confirmed — a
   *  partial apply is reported as such, never as a success (spec 018 Open Questions). */
  ok: boolean
}

/**
 * The post-write report (spec 018 P1): the group's committed offsets **as read back from
 * the broker**, not the ones we asked for.
 *
 * Reading them back is what makes a partial apply visible. A rebalance mid-write can leave
 * some partitions moved and others not, and a status line that echoed the plan would claim
 * a write that did not happen.
 */
export function seekResult(
  groupId: string,
  topic: string,
  planned: readonly SeekRow[],
  actual: readonly PartitionOffset[],
): SeekResult {
  const committed = new Map(actual.map((o) => [o.partition, o.committed]))
  const missed = movedRows(planned).filter((r) => committed.get(r.partition) !== r.after)
  const moved = movedRows(planned).length
  if (missed.length > 0) {
    const detail = missed
      .slice(0, MAX_LISTED_PARTITIONS)
      .map(
        (r) =>
          `p${r.partition} asked ${offsetCell(r.after)}, committed ${offsetCell(committed.get(r.partition) ?? null)}`,
      )
      .join(", ")
    return {
      ok: false,
      message: `${groupId} on ${topic}: ${moved - missed.length}/${moved} partitions moved — ${detail}`,
    }
  }
  const where = movedRows(planned)
    .slice(0, MAX_LISTED_PARTITIONS)
    .map((r) => `p${r.partition} @ ${offsetCell(r.after)}`)
    .join(", ")
  const more = moved > MAX_LISTED_PARTITIONS ? ` +${moved - MAX_LISTED_PARTITIONS} more` : ""
  return { ok: true, message: `${groupId} on ${topic} now committed ${where}${more}` }
}
