import { flattenFields } from "@/render/flatten.ts"

// Column inference for the message table (spec 007): sample the WHOLE loaded window, not
// the first message — a topic with mixed event subtypes would otherwise get the columns
// of whichever subtype happened to arrive first. Pure so it runs under `bun test`.

export interface Column {
  path: string
  header: string
  /** Widest sampled display, clamped — rows truncate to this, the header pads to it. */
  width: number
}

const DEFAULT_MAX_COLUMNS = 8
const MAX_COL_WIDTH = 28
const MIN_COL_WIDTH = 4

/** Flatten one decoded value to path → display. A path absent from the map is how
 *  "absent" stays distinct from a present-but-null field (nfr/006). */
export function fieldMap(value: unknown): Map<string, string> {
  const map = new Map<string, string>()
  for (const field of flattenFields(value)) {
    map.set(field.path, field.display)
  }
  return map
}

export function inferColumns(
  samples: readonly ReadonlyMap<string, string>[],
  opts: { maxColumns?: number } = {},
): Column[] {
  const maxColumns = opts.maxColumns ?? DEFAULT_MAX_COLUMNS
  const stats = new Map<string, { count: number; firstSeen: number; maxLen: number }>()
  for (const sample of samples) {
    for (const [path, display] of sample) {
      const entry = stats.get(path)
      if (entry) {
        entry.count++
        entry.maxLen = Math.max(entry.maxLen, display.length)
      } else {
        stats.set(path, { count: 1, firstSeen: stats.size, maxLen: display.length })
      }
    }
  }
  return (
    [...stats.entries()]
      // Frequency first — the fields most messages share are the topic's real shape; the
      // firstSeen tiebreak keeps equally-common fields from reshuffling between renders.
      .sort(([, a], [, b]) => b.count - a.count || a.firstSeen - b.firstSeen)
      .slice(0, maxColumns)
      .map(([path, s]) => {
        const header = path === "" ? "value" : path
        return {
          path,
          header,
          width: Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, header.length, s.maxLen)),
        }
      })
  )
}

/** Greedy prefix of the ranked columns that fits the given budget (P2 owns horizontal
 *  scroll — until then, overflow drops the rarest columns, never truncates the row). */
export function fitColumns(columns: readonly Column[], budget: number, gap: number): Column[] {
  const out: Column[] = []
  let used = 0
  for (const col of columns) {
    const cost = (out.length === 0 ? 0 : gap) + col.width
    if (used + cost > budget && out.length > 0) {
      break
    }
    out.push(col)
    used += cost
  }
  return out
}
