import type { ClusterProfile } from "@/config/schema.ts"
import { evaluateWrite, writeBlockedReason, type WriteAction } from "@/safety/gate.ts"
import { typeForSchemaId } from "@/schema/avroType.ts"
import { coerceToType, unknownFields } from "@/schema/coerce.ts"
import { encodeWithType, validate, type SchemaViolation } from "@/schema/encode.ts"
import { keySubject, valueSubject, type SchemaRegistry } from "@/schema/registry.ts"
import type { DecodedMessage } from "@/types.ts"
import { underPath, type ProduceOutcome } from "./outcome.ts"

// Cross-cluster copy (spec 016): decode against the **source** registry, resolve the same
// subject on the **destination** registry, re-encode, produce there.
//
// This is never a byte copy, and the code says so in its shape (nfr/006, invariant 3): a
// schema id is registry-local, so the id embedded in the payload means something else on the
// destination — re-producing the original bytes would hand that cluster's consumers an id
// that resolves, on their registry, to a different schema. The output bytes therefore differ
// from the input by construction, and the branch that could quietly avoid that does not
// exist: a field carrying a schema id is either re-encoded against the destination subject
// or the copy is refused. Nothing here reads `row.value` after a registry lookup fails.
//
// The two sides are separate registry objects with separate schema caches (avroType.ts keys
// its cache by registry instance). One registry serving both sides is exactly the bug this
// spec exists to prevent, so it is refused rather than trusted.

export interface CopySide {
  profile: ClusterProfile
  registry: SchemaRegistry
}

export interface CopyOptions {
  /** Where the message was read, and whose registry its schema ids belong to. */
  source: CopySide
  /** Where it is going. The destination's `allow_write` is what gates (spec 019). */
  destination: CopySide
  row: DecodedMessage
  /** The topic on the destination — prefix-mapped by the caller, editable in the bar. */
  destTopic: string
  now: () => Date
}

type Field = "value" | "key"

/** One field's journey, resolved before the dialog opens. `line` is what the dialog shows:
 *  both subjects with both versions and both ids, or the statement that this field had no
 *  schema id to translate. */
interface FieldPlan {
  bytes: Buffer | null
  line: string
}

type FieldOutcome = FieldPlan | { reason: string } | { violations: readonly SchemaViolation[] }

export async function planCopy(opts: CopyOptions): Promise<ProduceOutcome> {
  const { source, destination, row, destTopic, now } = opts
  const refusal =
    copyBlockedReason(source.profile, destination.profile, row) ??
    sharedRegistryRefusal(source, destination)
  if (refusal !== null) {
    return { kind: "refused", reason: refusal }
  }

  const value = await planField(opts, "value", row.value, row.decodedValue, row.valueSchemaId)
  if (!isPlan(value)) {
    return outcomeFor(value)
  }
  const key = await planField(opts, "key", row.key, row.decodedKey, row.keySchemaId)
  if (!isPlan(key)) {
    return outcomeFor(key)
  }

  const action: WriteAction = {
    kind: "copy",
    topic: destTopic,
    count: 1,
    oldest: row.timestamp,
    from: source.profile,
    fromTopic: row.topic,
    schemas: [value.line, key.line, headerLine(row)],
  }
  const gate = evaluateWrite(destination.profile, action, now())
  if (!gate.allowed) {
    return { kind: "refused", reason: gate.reason }
  }
  return {
    kind: "confirm",
    prompt: gate.prompt,
    action,
    produce: {
      topic: destTopic,
      // No `partition`: the destination topic's partition count is its own, so the source
      // partition number would be a coincidence at best and out of range at worst. The key
      // routes the record, as it routes every other producer's message on that topic.
      records: [{ key: key.bytes, value: value.bytes, headers: row.headers }],
    },
  }
}

/**
 * Why this copy cannot be attempted, from the two profiles and the message alone — no
 * connection needed, so the view can ask the moment a destination is highlighted rather
 * than after the topic has been typed.
 */
export function copyBlockedReason(
  source: ClusterProfile,
  destination: ClusterProfile,
  row: DecodedMessage,
): string | null {
  const blocked = writeBlockedReason(destination)
  if (blocked !== null) {
    return blocked
  }
  if (destination.name === source.name) {
    return "source and destination are the same cluster — p replays a message byte-exact where it already lives"
  }
  if (row.decodeError) {
    return `this message did not decode against ${source.name} (${row.decodeError}) — a copy has to re-encode it, and its bytes cannot be carried across as they are`
  }
  return null
}

/** One registry object is one schema cache, and a cache shared across two registries hands
 *  the destination's ids the source's schemas — the exact bug spec 016 exists to prevent.
 *  Checked rather than assumed of the caller, because the failure is silent: it produces
 *  bytes that decode into a different message. */
function sharedRegistryRefusal(source: CopySide, destination: CopySide): string | null {
  return destination.registry === source.registry
    ? "source and destination share one registry client — schema ids are registry-local and must not share a schema cache"
    : null
}

/**
 * Resolve one field onto the destination registry.
 *
 * A field with no Confluent header is not a fallback from a failed lookup — it is a
 * different case: it references no registry, so its bytes mean the same thing on both
 * clusters and are passed through. The dialog states which of the two happened, per field,
 * so "verbatim" is never something the user has to infer.
 */
async function planField(
  opts: CopyOptions,
  field: Field,
  bytes: Buffer | null,
  decoded: unknown,
  schemaId: number | undefined,
): Promise<FieldOutcome> {
  if (bytes === null) {
    // A tombstone is a statement; copying it as an empty buffer would mean the opposite
    // downstream (nfr/006).
    return {
      bytes: null,
      line: label(field, field === "value" ? "tombstone — copied as a deletion" : "none"),
    }
  }
  if (schemaId === undefined) {
    return { bytes, line: label(field, "no schema id in the payload — bytes carried verbatim") }
  }
  const { source, destination, destTopic, row } = opts
  const subject = subjectFor(destTopic, field)
  const latest = await destination.registry.getLatestSchema(subject)
  if (latest === null) {
    return {
      reason: `${destination.profile.name} has no schema registered for ${subject} — there is nothing to re-encode the ${field} against, and the source bytes are not an answer: their schema id ${schemaId} names a different schema on that registry`,
    }
  }
  const destType = await typeForSchemaId(destination.registry, latest.id)
  const coerced = coerceToType(destType, decoded)
  const violations = underPath(
    [...unknownFields(destType, coerced), ...validate(destType, coerced)],
    field,
  )
  if (violations.length > 0) {
    // The honest reading of "no compatible schema" (spec 016 P1): the destination subject
    // exists but does not accept this message. Naming the offending field beats
    // "incompatible", which leaves the user diffing two schemas by hand.
    return { violations }
  }
  const from = await sourceLabel(source, subjectFor(row.topic, field), schemaId)
  return {
    bytes: encodeWithType(destType, latest.id, coerced),
    line: label(field, `${from} → ${subject} v${latest.version} (id ${latest.id})`),
  }
}

/** The source side of a field's schema line. The version needs a lookup the payload cannot
 *  provide — it embeds an id, not a version — and a registry that will not answer costs the
 *  version, not the copy: the id on its own is still true. */
async function sourceLabel(source: CopySide, subject: string, schemaId: number): Promise<string> {
  const version = await source.registry.getVersionForId(subject, schemaId).catch(() => null)
  return version === null
    ? `${subject} (id ${schemaId})`
    : `${subject} v${version} (id ${schemaId})`
}

function subjectFor(topic: string, field: Field): string {
  return field === "value" ? valueSubject(topic) : keySubject(topic)
}

function headerLine(row: DecodedMessage): string {
  const count = Object.keys(row.headers).length
  return count === 0
    ? label("headers", "none")
    : label("headers", `${count} carried verbatim — header bytes reference no registry`)
}

function label(field: string, text: string): string {
  return `${field.padEnd(8)}${text}`
}

function isPlan(outcome: FieldOutcome): outcome is FieldPlan {
  return "line" in outcome
}

function outcomeFor(outcome: { reason: string } | { violations: readonly SchemaViolation[] }) {
  return "reason" in outcome
    ? ({ kind: "refused", reason: outcome.reason } as const)
    : ({ kind: "invalid", violations: outcome.violations } as const)
}
