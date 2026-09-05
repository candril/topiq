import { MISSING, walk } from "@/filter/compile.ts"
import type { DecodedMessage } from "@/types.ts"

// Client-side sort over the loaded window (spec 024). Kafka cannot sort, so this only
// ever reorders what is already here — the header says so.

export type SortDirection = "asc" | "desc"

export interface SortState {
  /** Column path, or null for the window's own order — newest first (`sortWindow`). */
  path: string | null
  direction: SortDirection
}

export const UNSORTED: SortState = { path: null, direction: "asc" }

/** asc → desc → unsorted, then round again. Selecting a different column starts fresh. */
export function cycleSort(current: SortState, path: string): SortState {
  if (current.path !== path) {
    return { path, direction: "asc" }
  }
  return current.direction === "asc" ? { path, direction: "desc" } : UNSORTED
}

const RANK: Record<string, number> = {
  bigint: 0,
  number: 0,
  boolean: 1,
  string: 2,
  object: 3,
}

/** Order two decoded leaf values. BigInt compares as BigInt — routing a long through
 *  Number here would reorder rows wrongly above 2^53 (nfr/006), which is the same class
 *  of silent wrongness the whole project exists to avoid. */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (typeof a === "bigint" && typeof b === "number") {
    return compareMixed(a, b)
  }
  if (typeof a === "number" && typeof b === "bigint") {
    return -compareMixed(b, a)
  }
  if (typeof a === "number" && typeof b === "number") {
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b)
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1
  }
  // Mixed types on one column (a topic with several event subtypes): group by kind so the
  // order is at least stable and explicable, rather than comparison-operator roulette.
  const rankA = RANK[typeof a] ?? 4
  const rankB = RANK[typeof b] ?? 4
  return rankA === rankB ? 0 : rankA < rankB ? -1 : 1
}

/** A BigInt and a Number: compare exactly. Converting the BigInt to Number would round it
 *  above 2^53; converting a fractional Number to BigInt would truncate it. */
function compareMixed(big: bigint, num: number): number {
  if (!Number.isFinite(num)) {
    return num > 0 ? -1 : 1
  }
  const truncated = BigInt(Math.trunc(num))
  if (big !== truncated) {
    return big < truncated ? -1 : 1
  }
  const fraction = num - Math.trunc(num)
  return fraction === 0 ? 0 : -1
}

/** Envelope fields are addressable by the same names the filter grammar uses, so sorting
 *  by `timestamp` and filtering on `timestamp:` mean the same field. */
function leafAt(row: DecodedMessage, path: string): unknown {
  switch (path) {
    case "partition":
      return row.partition
    case "offset":
      return row.offset
    case "timestamp":
      return row.timestamp.getTime()
    default:
      break
  }
  if (row.decodeError || row.value === null) {
    return MISSING
  }
  return walk(row.decodedValue, path.replace(/^value\./, "").split("."))
}

/**
 * Stable sort of the window by one column. Absent values sort last in **both**
 * directions: a reversed sort should not fill the top of the screen with rows that do not
 * have the field you asked to sort by.
 */
export function sortRows(
  rows: readonly DecodedMessage[],
  sort: SortState,
): readonly DecodedMessage[] {
  if (sort.path === null) {
    return rows
  }
  const path = sort.path
  const sign = sort.direction === "asc" ? 1 : -1
  // Decorate with the arrival index: Array.prototype.sort is stable in every engine we
  // target, but making the tiebreak explicit keeps the cursor from drifting on re-sorts.
  return rows
    .map((row, index) => ({ row, index, value: leafAt(row, path) }))
    .sort((a, b) => {
      const aMissing = a.value === MISSING
      const bMissing = b.value === MISSING
      if (aMissing || bMissing) {
        return aMissing && bMissing ? a.index - b.index : aMissing ? 1 : -1
      }
      const order = compareValues(a.value, b.value)
      return order === 0 ? a.index - b.index : order * sign
    })
    .map((entry) => entry.row)
}
