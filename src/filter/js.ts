import type { DecodedMessage } from "@/types.ts"
import type { CompileResult, Predicate } from "./types.ts"
import { MATCH_ALL } from "./types.ts"

// The JS escape hatch (spec 011): compile a user-written predicate once per edit and run
// it over the loaded window.
//
// DELIBERATELY NOT SANDBOXED. The source is the user's own, typed into their own
// terminal, in a process that already holds their cluster credentials — there is no
// privilege boundary here to defend. A sandbox would only cost fidelity, since BigInts
// and avsc-decoded class instances would have to survive the crossing (nfr/006). Do not
// "fix" this; see the Out of Scope section of specs/011-js-filter.md.
//
// No timeout guard either (011 P3, optional). Anything honest needs a Worker or a VM with
// an interrupt: a wall-clock check between messages cannot stop a `while (true)` inside
// one call, so it would read as protection without being any.

/** What the predicate sees. `key`/`value` are the DECODED values with BigInts intact
 *  (nfr/006), deliberately shadowing the raw-byte fields of `DecodedMessage` — the bytes
 *  stay reachable as `rawKey`/`rawValue`/`rawHeaders`. */
export interface FilterMessage {
  topic: string
  partition: number
  offset: bigint
  timestamp: Date
  key: unknown
  value: unknown
  /** utf8 view of the header bytes: headers are string-shaped by convention, and
   *  `headers.traceId === "abc"` is the only form anyone writes. `rawHeaders` has the
   *  bytes for the rare binary header. */
  headers: Record<string, string>
  rawKey: Buffer | null
  rawValue: Buffer | null
  rawHeaders: Record<string, Buffer>
  /** Set when decoding failed: `key`/`value` are then undefined and only bytes exist. */
  decodeError?: string
}

export interface JsRuntimeError {
  message: string
  /** The message that FIRST produced this error text — a stable anchor to point a row at,
   *  not the most recent one. */
  partition: number
  offset: bigint
  /** Throws since compile. One bad field path throws on every row, so this climbs while
   *  `message` stays put. */
  count: number
}

export interface JsCompileOptions {
  /** Fired on the first throw and again only when the error TEXT changes — a predicate
   *  that throws on all 10k rows must not storm the caller with 10k state updates. The
   *  `count` in a later `lastError()` read is therefore fresher than the one delivered
   *  here; pull it at render time if you show a tally. */
  onError?: (error: JsRuntimeError) => void
}

export interface JsFilter extends CompileResult {
  /** Pull-mode companion to `onError`, for callers that poll instead of subscribing.
   *  Null until the predicate throws. */
  lastError: () => JsRuntimeError | null
}

type RawPredicate = (msg: FilterMessage) => unknown

const ASYNC_HEAD = /^async[\s(]/
const ARROW_HEAD = /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
const FUNCTION_HEAD = /^function\b/

/**
 * Compile a filter source into a {@link Predicate} over the loaded window.
 *
 * Accepts a full arrow or function expression (`(msg) => …`, `msg => …`,
 * `({ value }) => …`, `function (msg) { … }`) or a bare body — an expression
 * (`msg.value.CustomerId > 100000000000n`) or a statement list that returns
 * (`if (!msg.value) return false; return msg.value.Id > 0n`). In the body forms the
 * message is bound to `msg`.
 *
 * A malformed source yields `error` and a match-all predicate: a filter the user cannot
 * see is worse than no filter, so nothing is hidden while the error is on screen
 * (nfr/004). A throw at call time skips that one message and is reported through
 * `onError` / `lastError`, never propagated.
 */
export function compileJs(source: string, options: JsCompileOptions = {}): JsFilter {
  const trimmed = source.trim()
  if (trimmed === "") {
    return { predicate: MATCH_ALL, error: null, lastError: () => null }
  }
  if (ASYNC_HEAD.test(trimmed)) {
    return failed("A predicate must be synchronous — `async` is not supported.")
  }

  const compiled = compileFunction(trimmed)
  if (compiled.fn === null) {
    return failed(compiled.error)
  }
  const fn = compiled.fn

  let last: JsRuntimeError | null = null
  function record(message: string, msg: DecodedMessage): void {
    const count = (last?.count ?? 0) + 1
    if (last !== null && last.message === message) {
      last = { ...last, count }
      return
    }
    last = { message, partition: msg.partition, offset: msg.offset, count }
    options.onError?.(last)
  }

  const predicate: Predicate = (msg) => {
    try {
      const result = fn(toFilterMessage(msg))
      if (typeof result === "function" || isThenable(result)) {
        // Both are always truthy, so letting them through would silently match every
        // row — the one filter failure mode that looks like success.
        throw new TypeError("Predicate must return a boolean, not a function or a promise.")
      }
      return Boolean(result)
    } catch (error) {
      record(formatError(error), msg)
      return false
    }
  }

  return { predicate, error: null, lastError: () => last }
}

function failed(error: string): JsFilter {
  return { predicate: MATCH_ALL, error, lastError: () => null }
}

function compileFunction(source: string): { fn: RawPredicate | null; error: string } {
  let firstError: string | null = null
  for (const candidate of candidateSources(source)) {
    try {
      // Strict mode so a mutating predicate throws rather than failing silently, and so
      // the user's own arrow inherits it.
      const fn: unknown = new Function(`"use strict"; return (${candidate})`)()
      if (typeof fn !== "function") {
        return { fn: null, error: "Source must evaluate to a function or to a condition on `msg`." }
      }
      return { fn: fn as RawPredicate, error: "" }
    } catch (error) {
      firstError ??= formatError(error)
    }
  }
  return { fn: null, error: firstError ?? "Empty predicate." }
}

/** Wrappings to try, best reading first — the first one's syntax error is the one the
 *  user gets, so a body that returns must be read as a statement list before it is read
 *  as an expression. */
function candidateSources(source: string): string[] {
  if (ARROW_HEAD.test(source) || FUNCTION_HEAD.test(source)) {
    return [source]
  }
  // Redpanda Console's filters read `value.x`, `key`, `partitionID` as bare names, and
  // that is the dialect people arrive with — so a bare body gets them bound. A full
  // arrow/function the user wrote themselves is passed through untouched: they named
  // their own parameter and should get exactly what they wrote.
  //
  // `headers` is bound only when the source mentions it: the message view decodes headers
  // lazily, and destructuring it unconditionally would utf8-decode every header of every
  // row for predicates that never look.
  const bind =
    "const { topic, partition, offset, timestamp, key, value } = msg, partitionID = partition;" +
    (/\bheaders\b/.test(source) ? " const { headers } = msg;" : "")
  const expression = `(msg) => {${bind} return (${source})}`
  const block = `(msg) => {${bind}\n${source}\n}`
  return /\breturn\b/.test(source) ? [block, expression] : [expression, block]
}

function toFilterMessage(msg: DecodedMessage): FilterMessage {
  let headers: Record<string, string> | undefined
  // Frozen so `msg.value = …` throws under strict mode instead of silently doing nothing.
  // Shallow only: a deep freeze would have to walk every decoded record on every row, and
  // the objects are shared with the table. Read-only stays a contract (011 Out of Scope).
  return Object.freeze({
    topic: msg.topic,
    partition: msg.partition,
    offset: msg.offset,
    timestamp: msg.timestamp,
    key: msg.decodedKey,
    value: msg.decodedValue,
    // Lazy: most predicates never look at headers, and utf8-decoding all of them on every
    // row of a full window is pure waste.
    get headers(): Record<string, string> {
      headers ??= decodeHeaders(msg.headers)
      return headers
    },
    rawKey: msg.key,
    rawValue: msg.value,
    rawHeaders: msg.headers,
    decodeError: msg.decodeError,
  })
}

function decodeHeaders(raw: Record<string, Buffer>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, bytes] of Object.entries(raw)) {
    out[name] = bytes.toString("utf8")
  }
  return out
}

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function"
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "Error" ? error.message : `${error.name}: ${error.message}`
  }
  return String(error)
}
