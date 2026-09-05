import type avro from "avsc"
import type { ClusterProfile } from "@/config/schema.ts"
import { editInEditor, type Suspendable } from "@/editor/view.ts"
import type { ProduceRecord } from "@/kafka/types.ts"
import { evaluateWrite, writeBlockedReason, type WriteAction } from "@/safety/gate.ts"
import { typeForSchemaId } from "@/schema/avroType.ts"
import { coerceToType, unknownFields } from "@/schema/coerce.ts"
import { encodeWithType, validate, type SchemaViolation } from "@/schema/encode.ts"
import {
  keySubject,
  valueSubject,
  type LatestSchema,
  type SchemaRegistry,
} from "@/schema/registry.ts"
import { skeletonFor, unionNotes } from "@/schema/skeleton.ts"
import { craftBuffer, parseCraftBuffer, schemaLabel, type CraftEnvelope } from "./craftBuffer.ts"
import { isEmptyBuffer } from "./editBuffer.ts"
import { underPath, type ProduceOutcome } from "./outcome.ts"

// Craft a message that does not exist yet (spec 015): the subject's **latest** schema →
// skeleton → $EDITOR → validate → encode → the same gated produce as spec 014.
//
// Latest, not an embedded id, is the one deliberate difference from spec 014. A new message
// is current by definition, and there is no original message whose readers a silent schema
// upgrade could surprise. Which version that resolved to is in the buffer header and in the
// confirm dialog, so "latest" is never something the user has to take on trust.
//
// Registering a schema is out of scope (spec 015): crafting works only against a subject
// the registry already has, and an unregistered subject is refused rather than guessed at.

export interface CraftOptions {
  renderer: Suspendable
  /** Needs the subject side of the registry, not just by-id lookup. */
  registry: SchemaRegistry
  /** The connected cluster, which is what the write is gated on (spec 019). */
  profile: ClusterProfile | null
  topic: string
  now: () => Date
}

interface Subject {
  latest: LatestSchema
  type: avro.Type
}

export async function craftMessage(opts: CraftOptions): Promise<ProduceOutcome> {
  const { renderer, registry, profile, topic, now } = opts
  const blocked = writeBlockedReason(profile)
  if (blocked !== null) {
    return { kind: "refused", reason: blocked }
  }
  // Both schemas are fetched before the editor opens: a registry outage should cost a status
  // line, not an edit the user has already typed.
  const value = await subject(registry, valueSubject(topic))
  if (value === null) {
    return {
      kind: "refused",
      reason: `no schema registered for ${valueSubject(topic)} — crafting needs one the registry already has`,
    }
  }
  const key = await subject(registry, keySubject(topic))

  const skeleton: CraftEnvelope = {
    key: key === null ? null : skeletonFor(key.type),
    value: skeletonFor(value.type),
    headers: {},
  }
  const saved = await editInEditor(
    renderer,
    craftBuffer({
      topic,
      value: value.latest,
      key: key?.latest ?? null,
      skeleton,
      notes: unionNotes(value.type),
    }),
    "message-craft.jsonc",
  )
  if (isEmptyBuffer(saved)) {
    return { kind: "aborted", reason: "the buffer was emptied — nothing produced" }
  }
  const parsed = parse(saved)
  if ("error" in parsed) {
    return { kind: "refused", reason: `the buffer was not read — ${parsed.error}` }
  }
  // Unlike an edit (spec 014), an untouched buffer is not an abort: the skeleton is a valid
  // message, and "produce a default event on this topic" is a thing people mean to do. The
  // confirm dialog is what stands between a stray `:wq` and a write.
  const envelope = parsed.envelope

  const coercedValue = coerceToType(value.type, envelope.value)
  const coercedKey =
    key === null || envelope.key === null ? null : coerceToType(key.type, envelope.key)
  const violations = [
    ...underPath(check(value.type, coercedValue), "value"),
    ...(key === null || envelope.key === null ? [] : underPath(check(key.type, coercedKey), "key")),
    ...plainKeyViolations(key, envelope.key, topic),
    ...headerViolations(envelope.headers),
  ]
  if (violations.length > 0) {
    return { kind: "invalid", violations }
  }

  const encoded = encodeRecord(value, key, envelope, coercedValue, coercedKey)
  if ("error" in encoded) {
    return { kind: "refused", reason: `encode failed — ${encoded.error}` }
  }
  const action: WriteAction = {
    kind: "craft",
    topic,
    count: 1,
    schema: schemaLabel(value.latest),
  }
  const gate = evaluateWrite(profile, action, now())
  if (!gate.allowed) {
    return { kind: "refused", reason: gate.reason }
  }
  return {
    kind: "confirm",
    prompt: gate.prompt,
    action,
    produce: { topic, records: [encoded.record] },
  }
}

async function subject(registry: SchemaRegistry, name: string): Promise<Subject | null> {
  const latest = await registry.getLatestSchema(name)
  if (latest === null) {
    return null
  }
  // Through the id rather than the response text, so this is the same type instance the
  // decode path holds for that id — one definition of what the schema means.
  return { latest, type: await typeForSchemaId(registry, latest.id) }
}

function check(type: avro.Type, value: unknown): SchemaViolation[] {
  return [...unknownFields(type, value), ...validate(type, value)]
}

/** A topic whose `-key` subject is not registered takes a plain key: a JSON string, produced
 *  as UTF-8 bytes, or null for no key. Anything else is refused rather than guessed at —
 *  there is no schema here to say what the bytes should have been. */
function plainKeyViolations(key: Subject | null, raw: unknown, topic: string): SchemaViolation[] {
  if (key !== null || raw === null || typeof raw === "string") {
    return []
  }
  return [
    {
      path: "key",
      value: raw,
      expected: "string",
      message: `${keySubject(topic)} is not registered, so the key must be a string (produced as UTF-8 bytes) or null`,
    },
  ]
}

function headerViolations(headers: Record<string, unknown>): SchemaViolation[] {
  return Object.entries(headers)
    .filter(([, v]) => typeof v !== "string")
    .map(([name, v]) => ({
      path: `headers.${name}`,
      value: v,
      expected: "string",
      message: "header values are produced as UTF-8 bytes, so they must be strings",
    }))
}

function encodeRecord(
  value: Subject,
  key: Subject | null,
  envelope: CraftEnvelope,
  coercedValue: unknown,
  coercedKey: unknown,
): { record: ProduceRecord } | { error: string } {
  try {
    return {
      // No `partition`: the key's partitioner routes a crafted message the way every other
      // producer on the topic routes one (spec 013).
      record: {
        key: keyBytes(key, envelope.key, coercedKey),
        value: encodeWithType(value.type, value.latest.id, coercedValue),
        headers: Object.fromEntries(
          Object.entries(envelope.headers).map(([name, v]) => [
            name,
            Buffer.from(String(v), "utf8"),
          ]),
        ),
      },
    }
  } catch (failure) {
    return { error: failure instanceof Error ? failure.message : String(failure) }
  }
}

function keyBytes(key: Subject | null, raw: unknown, coerced: unknown): Buffer | null {
  if (raw === null) {
    return null
  }
  return key === null
    ? Buffer.from(raw as string, "utf8")
    : encodeWithType(key.type, key.latest.id, coerced)
}

function parse(text: string): { envelope: CraftEnvelope } | { error: string } {
  try {
    return { envelope: parseCraftBuffer(text) }
  } catch (failure) {
    return { error: failure instanceof Error ? failure.message : String(failure) }
  }
}
