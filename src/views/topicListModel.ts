import type { PartitionMeta, TopicSummary } from "@/types.ts"
import { groupDigits } from "@/kafka/groups.ts"
import { messageCount } from "@/kafka/range.ts"

// Pure list logic for the topic list (spec 006): row shaping, visibility rules, sorting.
// Kept out of the component so it runs under `bun test` without a renderer.

export type TopicSort = "name" | "messages" | "partitions"

export const SORT_CYCLE: TopicSort[] = ["name", "messages", "partitions"]

/** Watermarks the list has measured so far, by topic name (spec 006). */
export type Measured = ReadonlyMap<string, PartitionMeta[]>

export interface TopicRow {
  name: string
  partitionCount: number
  /** Σ high − low: approximate — compaction and retention gaps make it an upper bound.
   *  `null` while the row's watermarks are unmeasured — never 0, which is a real count. */
  messages: bigint | null
}

/** `__consumer_offsets`, `_schemas`, … — the broker-side convention is a `_` prefix. */
export function isInternal(name: string): boolean {
  return name.startsWith("_")
}

export function toRow(summary: TopicSummary, measured: Measured): TopicRow {
  const partitions = measured.get(summary.name)
  return {
    name: summary.name,
    partitionCount: summary.partitionCount,
    messages: partitions ? messageCount(partitions) : null,
  }
}

export interface VisibleOptions {
  filter: string
  showInternal: boolean
  sort: TopicSort
  /** Prefixed profiles show only their namespace (spec 002). */
  topicPrefix?: string
}

function compare(sort: TopicSort, a: TopicRow, b: TopicRow): number {
  switch (sort) {
    case "name":
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    case "messages":
      // Descending: "which topics carry the data" is the question this sort answers.
      // Unmeasured rows sink to the bottom rather than pretending to be empty — the view
      // measures everything before it offers this sort, so they are a transient state.
      if (a.messages === null || b.messages === null) {
        return a.messages === b.messages ? 0 : a.messages === null ? 1 : -1
      }
      return a.messages === b.messages ? 0 : a.messages > b.messages ? -1 : 1
    case "partitions":
      return b.partitionCount - a.partitionCount
  }
}

export function visibleRows(
  topics: readonly TopicSummary[],
  measured: Measured,
  opts: VisibleOptions,
): TopicRow[] {
  const needle = opts.filter.toLowerCase()
  const rows = topics
    .filter((t) => {
      // Internal topics answer only to the toggle: a prefixed profile would otherwise
      // never be able to reveal them, since they sit outside every namespace.
      if (isInternal(t.name)) {
        return opts.showInternal
      }
      return !opts.topicPrefix || t.name.startsWith(opts.topicPrefix)
    })
    .filter((t) => t.name.toLowerCase().includes(needle))
    .map((t) => toRow(t, measured))
  return rows.sort((a, b) => compare(opts.sort, a, b) || (a.name < b.name ? -1 : 1))
}

/** First visible row of a fixed-height window that keeps the cursor centred once the
 *  list outgrows the viewport — plain slicing, no scrollbox geometry to chase. */
export function windowStart(cursor: number, rowCount: number, height: number): number {
  if (rowCount <= height) {
    return 0
  }
  return Math.max(0, Math.min(cursor - Math.floor(height / 2), rowCount - height))
}

/** Most partition rows the detail pane shows at once — beyond this it scrolls (spec 006). */
export const PANE_MAX_ROWS = 8

/** The pane borrows height from the topic list, so it takes the smaller of what it needs,
 *  its own cap, and what the list can spare. Never zero: a one-row pane still says how
 *  many partitions are hidden. */
export function partitionPaneRows(count: number, available: number): number {
  return Math.max(1, Math.min(count, PANE_MAX_ROWS, available))
}

/** Names the visible slice so the hidden partitions are stated, not silently cut off
 *  (nfr/004): "partitions 9–16 of 64". */
export function partitionRangeLabel(start: number, shown: number, total: number): string {
  if (shown >= total) {
    return `${total} partitions`
  }
  return `partitions ${start + 1}–${start + shown} of ${total}`
}

/** "~1,234,567" — the tilde keeps the approximation honest (spec 006). */
export function formatApprox(n: bigint): string {
  return `~${groupDigits(n)}`
}

/** An unmeasured row reads "—", never "~0": the count is unknown, not zero (spec 006). */
export function formatRowCount(messages: bigint | null): string {
  return messages === null ? "—" : formatApprox(messages)
}
