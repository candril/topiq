// Filter grammar → AST (spec 010 P1). Whitespace-separated terms, implicitly ANDed:
// `field:value` equality, `field>x` / `field<x` ordering, a bare word substring match, and
// a leading `-` negating any of them.
//
// Literals stay raw text here. The decoded type of the field decides how a literal is read
// (nfr/006) and that type is only knowable per message, so typing belongs in compile.ts.

export const FIELD_ROOTS = ["key", "value", "headers", "partition", "offset", "timestamp"] as const

export type FieldRoot = (typeof FIELD_ROOTS)[number]

const ROOTS: ReadonlySet<string> = new Set(FIELD_ROOTS)

/** Envelope scalars: a dotted path below them addresses nothing. */
const SCALAR_ROOTS: ReadonlySet<string> = new Set(["partition", "offset", "timestamp"])

export type CompareOp = "eq" | "gt" | "lt"

const OPS: Readonly<Record<string, CompareOp>> = { ":": "eq", ">": "gt", "<": "lt" }

export interface FieldTerm {
  kind: "field"
  root: FieldRoot
  /** Path below the root; empty addresses the root itself. Under `headers` this is a
   *  single element holding the whole remainder — header names may contain dots. */
  path: string[]
  op: CompareOp
  literal: string
  negated: boolean
}

export interface TextTerm {
  kind: "text"
  literal: string
  negated: boolean
}

export type Term = FieldTerm | TextTerm

export interface Query {
  /** Implicit AND; an empty list matches everything. */
  terms: Term[]
}

export interface ParseResult {
  query: Query | null
  /** Non-null exactly when `query` is null — the bar shows it inline (nfr/004). */
  error: string | null
}

interface Lexeme {
  /** Path and literal concatenated, quotes resolved; `opIndex` is the seam. */
  text: string
  opIndex: number
  op: CompareOp | null
  opChar: string
  negated: boolean
  /** `key:""` is an empty-string match; a bare `key:` is a half-typed term. */
  quotedLiteral: boolean
}

const FIELD_LIST = FIELD_ROOTS.join(", ")

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r"
}

function lex(input: string): { lexemes: Lexeme[]; error: string | null } {
  const lexemes: Lexeme[] = []
  let i = 0
  while (i < input.length) {
    if (isSpace(input[i]!)) {
      i++
      continue
    }
    let text = ""
    let opIndex = -1
    let op: CompareOp | null = null
    let opChar = ""
    let quotedLiteral = false
    let quoted = false
    const negated = input[i] === "-"
    if (negated) {
      i++
    }
    while (i < input.length) {
      const ch = input[i]!
      if (!quoted && isSpace(ch)) {
        break
      }
      if (ch === '"') {
        quoted = !quoted
        if (op !== null) {
          quotedLiteral = true
        }
        i++
        continue
      }
      if (quoted && ch === "\\" && i + 1 < input.length) {
        text += input[i + 1]
        i += 2
        continue
      }
      // Only the first operator splits the token, so `value.Url:http://x` keeps the rest
      // of the URL as its literal.
      if (!quoted && op === null && OPS[ch] !== undefined) {
        op = OPS[ch]!
        opChar = ch
        opIndex = text.length
        i++
        continue
      }
      text += ch
      i++
    }
    if (quoted) {
      return { lexemes: [], error: 'unterminated quote: close the " or remove it' }
    }
    lexemes.push({ text, opIndex, op, opChar, negated, quotedLiteral })
  }
  return { lexemes, error: null }
}

function fieldTerm(lexeme: Lexeme): { term: FieldTerm | null; error: string | null } {
  const pathText = lexeme.text.slice(0, lexeme.opIndex)
  const literal = lexeme.text.slice(lexeme.opIndex)
  if (pathText === "") {
    return { term: null, error: `expected a field name before "${lexeme.opChar}"` }
  }
  const segments = pathText.split(".")
  const root = segments[0]!.toLowerCase()
  if (!ROOTS.has(root)) {
    return {
      term: null,
      error: `unknown field "${segments[0]}" (expected one of ${FIELD_LIST}); quote the term to search for it as text`,
    }
  }
  if (segments.slice(1).some((segment) => segment === "")) {
    return { term: null, error: `empty path segment in "${pathText}"` }
  }
  if (segments.length > 1 && SCALAR_ROOTS.has(root)) {
    return { term: null, error: `"${root}" has no sub-fields` }
  }
  if (literal === "" && !lexeme.quotedLiteral) {
    return { term: null, error: `expected a value after "${pathText}${lexeme.opChar}"` }
  }
  const path =
    segments.length === 1
      ? []
      : root === "headers"
        ? [pathText.slice(root.length + 1)]
        : segments.slice(1)
  return {
    term: {
      kind: "field",
      root: root as FieldRoot,
      path,
      op: lexeme.op!,
      literal,
      negated: lexeme.negated,
    },
    error: null,
  }
}

/** Never throws: a malformed expression comes back as `error` (nfr/004). */
export function parse(input: string): ParseResult {
  const { lexemes, error } = lex(input)
  if (error !== null) {
    return { query: null, error }
  }
  const terms: Term[] = []
  for (const lexeme of lexemes) {
    if (lexeme.op === null) {
      if (lexeme.text === "" && lexeme.negated) {
        return { query: null, error: 'expected a term after "-"' }
      }
      terms.push({ kind: "text", literal: lexeme.text, negated: lexeme.negated })
      continue
    }
    const { term, error: termError } = fieldTerm(lexeme)
    if (termError !== null || term === null) {
      return { query: null, error: termError }
    }
    terms.push(term)
  }
  return { query: { terms }, error: null }
}
