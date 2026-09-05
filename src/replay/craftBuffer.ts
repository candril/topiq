import { stringifyEditable } from "@/render/json.ts"
import type { LatestSchema } from "@/schema/registry.ts"
import type { UnionNote } from "@/schema/skeleton.ts"
import { parseEditBuffer } from "./editBuffer.ts"

// The $EDITOR buffer for spec 015 and its reader. Pure, so the whole round trip is testable
// without spawning an editor.
//
// Unlike spec 014's value-only buffer, this one is an envelope: a crafted message has no
// original key to re-produce, and a null key on a keyed topic partitions at random and
// breaks compaction — silently. So key, value and headers are all in the buffer, and the
// header block says how each is turned into bytes.

export interface CraftEnvelope {
  /** null means "no key" — a legitimate Kafka record, and the only honest reading of a
   *  key the user deleted. */
  key: unknown
  value: unknown
  headers: Record<string, unknown>
}

export interface CraftBufferInput {
  topic: string
  value: LatestSchema
  /** null when `<topic>-key` is not registered: the key is then a plain UTF-8 string. */
  key: LatestSchema | null
  skeleton: CraftEnvelope
  /** Union positions in the *value* schema — which fields may be null, and what else they
   *  accept. JSON has no comments past the header, so this is where "optional" is said. */
  notes: readonly UnionNote[]
}

const MEMBERS = ["key", "value", "headers"] as const

const RULES = [
  "//",
  "// Edit the JSON below, save and quit. Everything after this comment block must be",
  "// valid JSON — comments are only stripped from the top of the file.",
  "// Integers are bare literals: which ones are int64 is read back from the schema, so",
  "// nothing has to be quoted to stay exact.",
  '// Byte fields are full hex in a string ("0x1f8b…"); that form is read back as bytes.',
  "// Arrays and maps carry one sample entry so their shape is visible — delete it for an",
  "// empty one.",
  '// "key": null produces a record with no key (the broker partitions it at random).',
  "// Header values are strings, produced as UTF-8 bytes.",
]

/** The editable document: what it will be encoded against as comments, then the skeleton. */
export function craftBuffer(input: CraftBufferInput): string {
  const head = [
    `// topiq — craft a new message for ${input.topic}`,
    `// value     ${schemaLabel(input.value)}`,
    `// key       ${input.key === null ? plainKeyNote(input.topic) : schemaLabel(input.key)}`,
    ...unionLines(input.notes),
    ...RULES,
  ]
  return `${head.join("\n")}\n${stringifyEditable(ordered(input.skeleton))}\n`
}

/** The subject and version this buffer will be encoded against. Spelled out because spec
 *  015 encodes against the subject's *latest*, not against anything on screen — the one
 *  place that decision is visible before the confirm dialog. */
export function schemaLabel(schema: LatestSchema): string {
  return `${schema.subject} v${schema.version} (id ${schema.id})`
}

function plainKeyNote(topic: string): string {
  return `${topic}-key is not registered — a JSON string is produced as UTF-8 bytes, null as no key`
}

function unionLines(notes: readonly UnionNote[]): string[] {
  if (notes.length === 0) {
    return []
  }
  return [
    "//",
    "// value fields that accept more than one type (null means the field may be omitted):",
    ...notes.map((n) => `//   ${n.path}: ${n.branches.join(" | ")}`),
  ]
}

function ordered(envelope: CraftEnvelope): Record<string, unknown> {
  // Fixed member order: the value is the thing being written, and a buffer whose members
  // move between openings is a buffer you have to re-read every time.
  return { key: envelope.key, value: envelope.value, headers: envelope.headers }
}

/**
 * Read the saved buffer back into an envelope. Throws with a message the status line can
 * show: invalid JSON, a body that is not an envelope, a missing `value`, or a member the
 * envelope has no meaning for — a typo'd `"vlaue"` would otherwise be produced as a
 * message missing its whole payload.
 */
export function parseCraftBuffer(text: string): CraftEnvelope {
  const parsed = parseEditBuffer(text)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail('the buffer must hold an object with "key", "value" and "headers"')
  }
  const body = parsed as Record<string, unknown>
  const unknown = Object.keys(body).filter((k) => !MEMBERS.includes(k as (typeof MEMBERS)[number]))
  if (unknown.length > 0) {
    return fail(`the envelope has no member ${unknown.map((k) => `"${k}"`).join(", ")}`)
  }
  if (!("value" in body)) {
    return fail('the buffer has no "value" — there is nothing to produce')
  }
  const headers = body.headers ?? {}
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    return fail('"headers" must be an object of strings')
  }
  return {
    key: body.key ?? null,
    value: body.value,
    headers: headers as Record<string, unknown>,
  }
}

function fail(reason: string): never {
  throw new Error(reason)
}
