// AST → predicate (spec 010 P1). One rule governs everything here: the comparator comes
// from the *decoded* type of the field, never from the shape of the literal (nfr/006). A
// BigInt field compares as BigInt, so `key:9007199254740993` is exact where a Number round
// trip would have folded it into its neighbour.

import { isRecord, stringify } from "@/render/json.ts"
import type { DecodedMessage } from "@/types.ts"
import type { CompareOp, FieldTerm, Query, Term } from "./parse.ts"
import { parse } from "./parse.ts"
import type { CompileResult, Predicate } from "./types.ts"
import { MATCH_ALL } from "./types.ts"

/** An absent path. Distinct from `null`, which is a value a field actually holds — the
 *  conflation nfr/006 exists to prevent. */
/** A path that is not present at all. Distinct from a present `null` (nfr/006) and
 *  exported so the sort comparator orders absent fields the same way. */
export const MISSING = Symbol("missing")

const INTEGER = /^[+-]?\d+$/
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

interface DateLiteral {
  ms: number
  /** A day-precision literal is a span: `timestamp:2026-08-01` means that whole UTC day. */
  day: boolean
}

/** ISO-8601, day precision or finer. JS resolves a bare date as UTC and a zoneless
 *  date-time as local time; that is the least surprising reading of what the user typed. */
function parseDate(literal: string): DateLiteral | null {
  if (!ISO_DATE.test(literal)) {
    return null
  }
  const ms = Date.parse(literal.replace(" ", "T"))
  return Number.isNaN(ms) ? null : { ms, day: ISO_DAY.test(literal) }
}

function order(op: CompareOp, delta: number): boolean {
  return op === "eq" ? delta === 0 : op === "gt" ? delta > 0 : delta < 0
}

function sign<T extends bigint | number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function matchesDate(actual: Date, op: CompareOp, literal: string): boolean {
  const parsed = parseDate(literal)
  if (parsed === null) {
    return false
  }
  const at = actual.getTime()
  if (op === "eq" && parsed.day) {
    return at >= parsed.ms && at < parsed.ms + DAY_MS
  }
  return order(op, sign(at, parsed.ms))
}

/** Raw bytes match on their UTF-8 reading or their hex, whichever the user typed — an
 *  undecodable key is only addressable as hex. */
function matchesBytes(actual: Uint8Array, op: CompareOp, literal: string): boolean {
  if (op !== "eq") {
    return false
  }
  const buffer = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
  const hex = literal.startsWith("0x") || literal.startsWith("0X") ? literal.slice(2) : literal
  return buffer.toString("utf8") === literal || buffer.toString("hex") === hex.toLowerCase()
}

/** `/pattern/flags` — a regex literal, as in monq. Returns null when the text is not one,
 *  so a value that merely starts with a slash (a path, a URL) stays a plain string. */
export function parseRegexLiteral(literal: string): RegExp | null {
  if (literal.length < 2 || !literal.startsWith("/")) {
    return null
  }
  const end = literal.lastIndexOf("/")
  if (end === 0) {
    return null
  }
  const flags = literal.slice(end + 1)
  if (!/^[dgimsuvy]*$/.test(flags)) {
    return null
  }
  try {
    // Case-insensitive by default, matching the grammar's plain `field:value` equality —
    // an explicit flag list overrides it.
    return new RegExp(literal.slice(1, end), flags === "" ? "i" : flags)
  } catch {
    return null
  }
}

/** A regex tests the value's *rendered* form, so `value.Id:/^71719/` works on a BigInt and
 *  a record subtree alike. Only `:` takes one — ordering a value against a pattern is
 *  meaningless. */
function matchesRegex(actual: unknown, op: CompareOp, pattern: RegExp): boolean {
  if (op !== "eq" || actual === MISSING || actual === undefined) {
    return false
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => matchesRegex(item, op, pattern))
  }
  const text =
    typeof actual === "string"
      ? actual
      : actual instanceof Uint8Array
        ? Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).toString("utf8")
        : stringify(actual)
  // A regex is stateful when it carries /g; reset so a repeated test over rows is honest.
  pattern.lastIndex = 0
  return pattern.test(text)
}

function matches(actual: unknown, op: CompareOp, literal: string): boolean {
  if (actual === MISSING || actual === undefined) {
    return false
  }
  const pattern = parseRegexLiteral(literal)
  if (pattern !== null) {
    return matchesRegex(actual, op, pattern)
  }
  if (actual === null) {
    return op === "eq" && literal.toLowerCase() === "null"
  }
  switch (typeof actual) {
    case "bigint":
      // BigInt(literal) — never Number(literal): above 2^53 that is the whole ballgame.
      return INTEGER.test(literal) && order(op, sign(actual, BigInt(literal)))
    case "number":
      return NUMBER.test(literal) && order(op, sign(actual, Number(literal)))
    case "boolean":
      return op === "eq" && literal.toLowerCase() === String(actual)
    case "string":
      return op === "eq"
        ? actual.toLowerCase() === literal.toLowerCase()
        : order(op, sign(actual, literal))
    case "object":
      break
    default:
      return false
  }
  if (actual instanceof Date) {
    return matchesDate(actual, op, literal)
  }
  if (actual instanceof Uint8Array) {
    return matchesBytes(actual, op, literal)
  }
  if (Array.isArray(actual)) {
    // Per element, not over the rendered array: `Tags:beta` must not match "betamax".
    return actual.some((item) => matches(item, op, literal))
  }
  if (isRecord(actual)) {
    // A whole subtree can only be searched, not equalled — same reading as a bare word.
    return op === "eq" && contains(stringify(actual), literal)
  }
  return false
}

/** Walk a dotted path into a decoded value; MISSING when any segment is absent.
 *  Shared with the column sort ([024]) so both agree on what "absent" means. */
export function walk(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const segment of path) {
    if (current === null || current === undefined) {
      return MISSING
    }
    if (Array.isArray(current)) {
      const index = INTEGER.test(segment) ? Number(segment) : -1
      if (index < 0 || index >= current.length) {
        return MISSING
      }
      current = current[index]
      continue
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return MISSING
    }
    current = current[segment]
  }
  return current
}

function headerText(msg: DecodedMessage, name: string): unknown {
  const raw = msg.headers[name]
  return raw === undefined ? MISSING : raw.toString("utf8")
}

function headerRecord(msg: DecodedMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(msg.headers)) {
    out[name] = raw.toString("utf8")
  }
  return out
}

function resolve(msg: DecodedMessage, term: FieldTerm): unknown {
  switch (term.root) {
    case "partition":
      return msg.partition
    case "offset":
      return msg.offset
    case "timestamp":
      return msg.timestamp
    case "headers":
      return term.path.length === 0 ? headerRecord(msg) : headerText(msg, term.path[0]!)
    case "key":
      return walk(msg.decodedKey, term.path)
    case "value":
      return walk(msg.decodedValue, term.path)
  }
}

/** The envelope scalars have a type before any message is seen, so a literal that can
 *  never match one of them is a mistake worth showing rather than an empty result set. */
function validate(term: Term): string | null {
  if (term.kind !== "field" || term.path.length > 0) {
    return null
  }
  if (term.root === "offset" || term.root === "partition") {
    return INTEGER.test(term.literal)
      ? null
      : `${term.root} expects a whole number, got "${term.literal}"`
  }
  if (term.root === "timestamp") {
    return parseDate(term.literal) === null
      ? `timestamp expects an ISO-8601 date, got "${term.literal}"`
      : null
  }
  return null
}

export function compileQuery(query: Query): Predicate {
  if (query.terms.length === 0) {
    return MATCH_ALL
  }
  // One render per message however many bare words the query has; the window can hold
  // thousands of rows and stringify walks the whole value (nfr/001).
  const rendered = new WeakMap<DecodedMessage, string>()
  const haystack = (msg: DecodedMessage): string => {
    const cached = rendered.get(msg)
    if (cached !== undefined) {
      return cached
    }
    const text = stringify(msg.decodedValue)
    rendered.set(msg, text)
    return text
  }
  const hit = (msg: DecodedMessage, term: Term): boolean =>
    term.kind === "text"
      ? contains(haystack(msg), term.literal)
      : matches(resolve(msg, term), term.op, term.literal)

  return (msg) => {
    try {
      return query.terms.every((term) => hit(msg, term) !== term.negated)
    } catch {
      // A predicate must never take the view down: the offending row is skipped (nfr/004).
      return false
    }
  }
}

/** Grammar text → predicate. On a malformed expression the predicate is `MATCH_ALL` and
 *  `error` is set; the bar shows it inline and keeps the previous result set. */
export function compile(input: string): CompileResult {
  const { query, error } = parse(input)
  if (query === null) {
    return { predicate: MATCH_ALL, error: error ?? "invalid filter" }
  }
  for (const term of query.terms) {
    const invalid = validate(term)
    if (invalid !== null) {
      return { predicate: MATCH_ALL, error: invalid }
    }
  }
  return { predicate: compileQuery(query), error: null }
}
