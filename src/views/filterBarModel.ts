import { compile } from "@/filter/compile.ts"
import { compileJs, type JsRuntimeError } from "@/filter/js.ts"
import type { CompileResult, Predicate } from "@/filter/types.ts"

// What the filter bar does to a line of text before a predicate exists (specs 010, 011):
// pick the tier, hand the compiler its source, and decide which predicate the window is
// actually filtered by. Pure — the bar and the hook stay renderers of this.

/**
 * A leading `=` switches the bar from the grammar to the JS escape hatch (spec 011):
 * `=msg.value.CustomerId > 100000000000n`.
 *
 * One string carries both tiers so no mode flag can drift out of sync with the text it
 * applies to — and so the whole filter is one value in the reducer, one thing to save as
 * history later (010 P2). `=` is free in the grammar: it is not an operator there, and a
 * bare word starting with `=` is not a substring anyone searches for.
 */
export const JS_PREFIX = "="

export type FilterMode = "grammar" | "js"

export interface FilterCompilation extends CompileResult {
  mode: FilterMode
  /** What the compiler was handed — the JS prefix removed. */
  source: string
  /** Non-null once a JS predicate has thrown on some row (spec 011); always null for the
   *  grammar tier, which cannot throw out to the caller. */
  lastError: () => JsRuntimeError | null
}

export function filterMode(query: string): FilterMode {
  return query.trimStart().startsWith(JS_PREFIX) ? "js" : "grammar"
}

export function filterSource(query: string): string {
  const trimmed = query.trimStart()
  return trimmed.startsWith(JS_PREFIX) ? trimmed.slice(JS_PREFIX.length) : query
}

/** Text → predicate, routed by prefix. Never throws: a malformed expression comes back as
 *  `error` with a match-all predicate, which the caller must not apply (see
 *  {@link effectivePredicate}). */
export function compileFilter(query: string): FilterCompilation {
  const mode = filterMode(query)
  const source = filterSource(query)
  if (mode === "js") {
    return { ...compileJs(source), mode, source }
  }
  return { ...compile(source), mode, source, lastError: () => null }
}

/**
 * The predicate the window is filtered by: the fresh one, or the last that compiled while
 * the expression is malformed.
 *
 * Half-typed text is malformed text — `key:` is an error on the way to `key:12345` — and
 * the compilers answer an error with match-all. Applying that would flash the whole
 * window back on every keystroke, so the previous result set stays on screen with the
 * error beside it instead (nfr/004).
 */
export function effectivePredicate(compiled: CompileResult, lastGood: Predicate): Predicate {
  return compiled.error === null ? compiled.predicate : lastGood
}

/** Window row count: `matched/total` only while a filter narrows it — an unfiltered
 *  window reads as one number, not "50/50" (spec 010 P1). */
export function rowCountLabel(matched: number, total: number, filtering: boolean): string {
  return filtering ? `${matched}/${total} rows` : `${total} rows`
}

/** A throw is pinned to the row that first produced it, so the user can go look at the
 *  message that broke their predicate rather than at a bare stack-less message. */
export function runtimeErrorLabel(error: JsRuntimeError): string {
  const times = error.count > 1 ? ` ×${error.count}` : ""
  return `${error.message} — p${error.partition}@${error.offset}${times}`
}

/** A blank or whitespace-only bar filters nothing — `=` alone is a JS mode with no
 *  predicate yet, not a filter either. */
export function isFiltering(query: string): boolean {
  return filterSource(query).trim() !== ""
}
