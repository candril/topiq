import { useMemo, useState } from "react"
import type { JsRuntimeError } from "@/filter/js.ts"
import { MATCH_ALL, type Predicate } from "@/filter/types.ts"
import {
  compileFilter,
  effectivePredicate,
  isFiltering,
  type FilterMode,
} from "./filterBarModel.ts"

// Text → the predicate the window is actually filtered by (specs 010, 011). Separate from
// applying it, because follow mode needs the predicate before any rows exist: arrivals are
// filtered as they land, ahead of the buffer (spec 012 P2).

export interface FilterPredicate {
  query: string
  predicate: Predicate
  mode: FilterMode
  /** Compile error, shown inline while the previous result set stays on screen. */
  error: string | null
  /** False while the bar is empty — the caller then shows one count, not "50/50". */
  filtering: boolean
  /** Read *after* the rows have been walked, so a throw raised this render is reported
   *  this render rather than one keystroke late. */
  lastError: () => JsRuntimeError | null
}

export function useFilterPredicate(query: string): FilterPredicate {
  const compiled = useMemo(() => compileFilter(query), [query])

  // Adjusted during render, not in an effect: an effect would paint one frame of the
  // wrong result set first. React discards this pass and re-runs it, and the discarded
  // pass already agreed with the new value — `effectivePredicate` prefers the fresh
  // predicate whenever it compiled.
  const [lastGood, setLastGood] = useState<Predicate>(() => MATCH_ALL)
  if (compiled.error === null && compiled.predicate !== lastGood) {
    setLastGood(() => compiled.predicate)
  }

  return {
    query,
    predicate: effectivePredicate(compiled, lastGood),
    mode: compiled.mode,
    error: compiled.error,
    filtering: isFiltering(query),
    lastError: compiled.lastError,
  }
}
