import { useMemo } from "react"
import type { JsRuntimeError } from "@/filter/js.ts"
import { MATCH_ALL } from "@/filter/types.ts"
import type { DecodedMessage } from "@/types.ts"
import type { FilterMode } from "./filterBarModel.ts"
import type { FilterPredicate } from "./useFilterPredicate.ts"

// The filter applied to the rows the table already holds (specs 010, 011) — no
// re-consume, no round trip: narrowing 10k loaded rows is a local array walk. Rows that
// arrived through the tail were already filtered on arrival (spec 012); re-testing them
// here is idempotent and keeps one count honest for both sources.

export interface FilteredMessages {
  rows: DecodedMessage[]
  matched: number
  total: number
  /** False while the bar is empty — the caller then shows one count, not "50/50". */
  filtering: boolean
  mode: FilterMode
  /** Compile error, shown inline while the previous result set stays on screen. */
  error: string | null
  /** A JS predicate that threw: those rows were skipped, the rest still filtered. */
  runtimeError: JsRuntimeError | null
}

export function useFilteredMessages(
  rows: DecodedMessage[],
  filter: FilterPredicate,
): FilteredMessages {
  const predicate = filter.predicate
  const filtered = useMemo(
    // MATCH_ALL is the common case; skipping the walk keeps an unfiltered window free of
    // a per-render copy of every row (nfr/001).
    () => (predicate === MATCH_ALL ? rows : rows.filter(predicate)),
    [rows, predicate],
  )

  return {
    rows: filtered,
    matched: filtered.length,
    total: rows.length,
    filtering: filter.filtering,
    mode: filter.mode,
    error: filter.error,
    // Pulled at render, not pushed through a callback: a predicate throwing on every row
    // of a full window would otherwise dispatch thousands of state updates (spec 011).
    runtimeError: filter.lastError(),
  }
}
