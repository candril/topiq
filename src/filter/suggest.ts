import { MISSING, walk } from "@/filter/compile.ts"
import { FIELD_ROOTS } from "@/filter/parse.ts"
import { stringify } from "@/render/json.ts"
import type { DecodedMessage } from "@/types.ts"

// Completion model for the filter bar (spec 010 P2), monq's shape: field names while
// typing a term, sampled values once the term has an operator. Pure — the component owns
// selection and rendering, this owns what is offered.

export interface Suggestion {
  /** What is shown in the list. */
  label: string
  /** The complete term this replaces the typed one with. */
  term: string
  /** Right-aligned annotation: a type, a count, where it came from. */
  hint?: string
}

const OPERATOR = /^([^:><]+)([:><])(.*)$/
const SAMPLE_LIMIT = 12
const SUGGESTION_LIMIT = 10

/** Split off the term being typed. Terms are space-separated (the grammar's implicit AND),
 *  so only the last one is under the cursor. */
export function splitLastTerm(input: string): { prefix: string; term: string } {
  const lastSpace = input.lastIndexOf(" ")
  return lastSpace === -1
    ? { prefix: "", term: input }
    : { prefix: input.slice(0, lastSpace + 1), term: input.slice(lastSpace + 1) }
}

/** Subsequence match with a bonus for consecutive and prefix hits — enough to rank
 *  "Cust" above "CreateDate" for "cu" without a scoring library. */
export function fuzzyScore(query: string, target: string): number {
  if (query === "") {
    return 1
  }
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) {
      return 0
    }
    streak = found === ti ? streak + 1 : 0
    score += 1 + streak + (found === 0 ? 2 : 0)
    ti = found + 1
  }
  return score
}

function rank(items: Suggestion[], query: string): Suggestion[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SUGGESTION_LIMIT)
    .map((entry) => entry.item)
}

/** Distinct decoded values at a field path across the loaded rows, as filter literals. */
function sampleValues(rows: readonly DecodedMessage[], field: string): Suggestion[] {
  const [root, ...path] = field.split(".")
  const seen = new Set<string>()
  const out: Suggestion[] = []
  for (const row of rows) {
    const value = valueAt(row, root ?? "", path)
    if (value === MISSING || value === undefined) {
      continue
    }
    const literal = typeof value === "string" ? value : stringify(value)
    if (literal === "" || seen.has(literal) || literal.includes(" ")) {
      continue
    }
    seen.add(literal)
    out.push({ label: literal, term: "", hint: typeof value })
    if (out.length >= SAMPLE_LIMIT) {
      break
    }
  }
  return out
}

function valueAt(row: DecodedMessage, root: string, path: readonly string[]): unknown {
  switch (root) {
    case "value":
      return row.decodeError ? MISSING : walk(row.decodedValue, path)
    case "key":
      return row.decodeError ? MISSING : walk(row.decodedKey, path)
    case "partition":
      return row.partition
    case "offset":
      return row.offset
    case "timestamp":
      return row.timestamp.toISOString()
    case "headers": {
      const name = path.join(".")
      const raw = row.headers[name]
      return raw === undefined ? MISSING : raw.toString("utf8")
    }
    default:
      return MISSING
  }
}

export interface SuggestInput {
  /** The whole filter text, as typed. */
  query: string
  /** Inferred column paths, relative to the decoded value (spec 007). */
  columns: readonly string[]
  rows: readonly DecodedMessage[]
}

/**
 * What to offer for the term under the cursor: field names before an operator, sampled
 * values after one. Returns [] when there is nothing useful to add, which is also how the
 * component decides not to draw.
 */
export function suggest({ query, columns, rows }: SuggestInput): Suggestion[] {
  const { term } = splitLastTerm(query)
  const bare = term.startsWith("-") ? term.slice(1) : term
  const negated = term.startsWith("-")
  const withSign = (t: string): string => (negated ? `-${t}` : t)

  const operator = OPERATOR.exec(bare)
  if (operator) {
    const [, field, op, partial] = operator as unknown as [string, string, string, string]
    const values = sampleValues(rows, field).map((s) => ({
      ...s,
      term: withSign(`${field}${op}${s.label}`),
    }))
    return rank(values, partial)
  }

  // Field position. Completion is progressive, one dotted segment at a time (monq): with
  // `val` typed you get `value.` and accepting it re-offers only what lives under it,
  // rather than dumping every leaf path of every root into one flat list.
  const segments = bare.split(".")
  const typedPath = segments.slice(0, -1).join(".")
  const partial = segments[segments.length - 1] ?? ""

  if (typedPath === "") {
    const roots = FIELD_ROOTS.map((root) => ({
      label: root,
      // A root that has children completes to `root.` so the next ^y drills in; a scalar
      // root goes straight to `root:` because there is nothing to drill into.
      term: withSign(hasChildren(root, columns) ? `${root}.` : `${root}:`),
      hint: hasChildren(root, columns) ? "namespace" : "field",
    }))
    return rank(roots, partial)
  }

  const children = childrenOf(typedPath, columns)
  return rank(
    children.map((child) => ({
      label: `${typedPath}.${child.name}`,
      term: withSign(`${typedPath}.${child.name}${child.leaf ? ":" : "."}`),
      hint: child.leaf ? "field" : "namespace",
    })),
    `${typedPath}.${partial}`,
  )
}

/** Column paths are relative to the decoded value, so only `value` has children today —
 *  headers get theirs when a row carries them (they are addressed by name, not by path). */
function hasChildren(root: string, columns: readonly string[]): boolean {
  return root === "value" && columns.length > 0
}

interface Child {
  name: string
  /** A leaf completes to `path:` (ready for a value); a namespace to `path.`. */
  leaf: boolean
}

/** One level below a dotted prefix, deduplicated: `value` over the columns
 *  [Entity.Id, Entity.Name, EventType] yields Entity (namespace) and EventType (leaf). */
function childrenOf(prefix: string, columns: readonly string[]): Child[] {
  if (prefix !== "value" && !prefix.startsWith("value.")) {
    return []
  }
  const under = prefix === "value" ? "" : `${prefix.slice("value.".length)}.`
  const seen = new Map<string, boolean>()
  for (const path of columns) {
    if (under !== "" && !path.startsWith(under)) {
      continue
    }
    const rest = path.slice(under.length)
    const dot = rest.indexOf(".")
    const name = dot === -1 ? rest : rest.slice(0, dot)
    if (name === "") {
      continue
    }
    // A name seen both as a leaf and as a prefix is a namespace: drilling in is the more
    // useful default, and `value.Entity:` still matches the subtree as text.
    seen.set(name, (seen.get(name) ?? true) && dot === -1)
  }
  return [...seen].map(([name, leaf]) => ({ name, leaf }))
}
