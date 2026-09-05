import { MISSING, walk } from "@/filter/compile.ts"
import { stringify } from "@/render/json.ts"
import type { DecodedMessage } from "@/types.ts"

// "Show me all the rows like this one" (spec 024 P2): turn the cell under the cursor into
// a filter term. The term is written into the bar rather than applied as a hidden
// predicate, so the filter stays one visible, editable expression (spec 010).

const BARE = /^[^\s"]+$/

/** Quote a literal the parser would otherwise mis-read: anything with a space, a quote,
 *  or nothing at all. */
function literalOf(value: unknown): string {
  const text = typeof value === "string" ? value : stringify(value)
  return BARE.test(text) && text !== "" ? text : `"${text.replaceAll('"', '\\"')}"`
}

function cellValue(row: DecodedMessage, path: string): unknown {
  switch (path) {
    case "partition":
      return row.partition
    case "offset":
      return row.offset
    case "timestamp":
      return row.timestamp
    default:
      break
  }
  if (row.decodeError || row.value === null) {
    return MISSING
  }
  return walk(row.decodedValue, path.replace(/^value\./, "").split("."))
}

/**
 * The filter term for one cell, or null when there is nothing to filter on — an absent
 * field, or a whole subtree, which would only ever match itself.
 */
export function cellFilterTerm(row: DecodedMessage, path: string): string | null {
  const value = cellValue(row, path)
  if (value === MISSING || value === undefined) {
    return null
  }
  const field =
    path === "partition" || path === "offset" || path === "timestamp"
      ? path
      : path.startsWith("value.")
        ? path
        : `value.${path}`
  if (value instanceof Date) {
    // Millisecond precision: two messages in the same second are common, and a
    // second-precision term would quietly widen the match.
    return `${field}:${value.toISOString()}`
  }
  if (value === null) {
    return `${field}:null`
  }
  if (typeof value === "object") {
    // A record or array cell has no equality the grammar can express — the rendered form
    // would be a substring search over the subtree, which is not what the cursor implies.
    return null
  }
  return `${field}:${literalOf(value)}`
}

/** Append a term to an existing filter, keeping the implicit AND and never duplicating. */
export function withTerm(query: string, term: string): string {
  const existing = query.trim()
  if (existing === "") {
    return term
  }
  // A JS predicate is not a term list; replacing it would throw away what the user wrote.
  if (existing.startsWith("=")) {
    return existing
  }
  return existing.split(/\s+/).includes(term) ? existing : `${existing} ${term}`
}
