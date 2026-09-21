// Dotted field paths + display values for table columns (007). Column inference joins
// these across the loaded window; a path missing from a message's list is how "absent"
// stays distinct from a present-but-null field (nfr/006).

import { formatTimestamp } from "@/time.ts"
import { isRecord, stringify, summarize } from "./json.ts"

export interface FlatField {
  path: string
  display: string
}

// Paths deeper than `a.b` are noise at row width — the detail pane owns deep structure.
const DEFAULT_MAX_DEPTH = 2

export function flattenFields(value: unknown, opts: { maxDepth?: number } = {}): FlatField[] {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  if (!isRecord(value)) {
    // Scalar, array, buffer or tombstone root: one pathless column so the row still renders.
    return [{ path: "", display: display(value) }]
  }
  const fields: FlatField[] = []
  collect(value, "", 1, maxDepth, fields)
  return fields
}

function collect(
  record: Record<string, unknown>,
  prefix: string,
  depth: number,
  maxDepth: number,
  out: FlatField[],
): void {
  for (const [key, child] of Object.entries(record)) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    if (isRecord(child) && depth < maxDepth && Object.keys(child).length > 0) {
      collect(child, path, depth + 1, maxDepth, out)
    } else {
      out.push({ path, display: display(child) })
    }
  }
}

// Arrays are never expanded into columns — element count varies per message, which would
// reshuffle the column set mid-scroll (007 requires stable inference).
function display(value: unknown): string {
  // A declared date (spec 031) renders the way the envelope timestamp two columns to the
  // left does. `stringify` would quote its ISO form, which is right for the JSON-shaped
  // document views and wrong for a table cell — the quotes cost width and make one column
  // of instants look unlike the other.
  if (value instanceof Date) {
    return formatTimestamp(value)
  }
  return Array.isArray(value) || isRecord(value) ? summarize(value) : stringify(value)
}
