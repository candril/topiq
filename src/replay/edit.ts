import type avro from "avsc"
import type { ClusterProfile } from "@/config/schema.ts"
import { editInEditor, type Suspendable } from "@/editor/view.ts"
import type { ProduceRecord } from "@/kafka/types.ts"
import { stringifyEditable } from "@/render/json.ts"
import { evaluateWrite, writeBlockedReason, type WriteAction } from "@/safety/gate.ts"
import { typeForSchemaId } from "@/schema/avroType.ts"
import { coerceToType, unknownFields } from "@/schema/coerce.ts"
import { encodeWithType, validate } from "@/schema/encode.ts"
import type { SchemaFetcher } from "@/schema/registry.ts"
import type { DecodedMessage } from "@/types.ts"
import { editBuffer, isEmptyBuffer, parseEditBuffer } from "./editBuffer.ts"
import type { ProduceOutcome } from "./outcome.ts"

// Edit-and-replay (spec 014): decode → $EDITOR → validate against the message's **own**
// schema id → encode → produce behind the gate.
//
// Deliberately not merged into produce.ts's byte-exact path (spec 013). This flow re-encodes
// by construction, so the bytes differ from the original even for a no-op edit; keeping the
// two apart is what lets 013 promise byte-exactness at all (nfr/006 invariant 2). The two
// entry points that could blur the line take different inputs on purpose: replayRecord takes
// a RawMessage and cannot see a decoded value, editedRecord takes bytes it was handed.
//
// The schema is the one the message carries, never the subject's latest: replaying a
// year-old record must not silently promote it onto a newer schema, which would change what
// a downstream consumer sees without anyone deciding to.

export type EditReplayOutcome = ProduceOutcome

export interface EditReplayOptions {
  renderer: Suspendable
  registry: SchemaFetcher
  /** The connected cluster, which is what the write is gated on (spec 019). */
  profile: ClusterProfile | null
  row: DecodedMessage
  now: () => Date
}

/**
 * The value bytes are new; the key and headers are the original `Buffer` instances (spec 014
 * P1 — only the value is editable).
 *
 * No `partition`, so the key's partitioner routes the edited record exactly as it routed the
 * original — an edited message landing on a different partition from the one it supersedes
 * is the quiet way this feature causes damage.
 */
export function editedRecord(row: DecodedMessage, value: Buffer): ProduceRecord {
  return { key: row.key, value, headers: row.headers }
}

/** Why this message cannot be edited, or null. Checked before the editor opens: making
 *  someone edit a buffer and *then* refusing it wastes the edit. */
export function editBlockedReason(row: DecodedMessage): string | null {
  if (row.decodeError) {
    return "this message did not decode — there is nothing to edit; p replays its bytes as they are"
  }
  if (row.value === null) {
    return "this message is a tombstone — it has no value to edit"
  }
  if (row.valueSchemaId === undefined) {
    // Without an embedded id there is no schema to validate against, and producing an
    // unvalidated re-encode of a guessed shape is worse than refusing (spec 014 P1).
    return "this value carries no schema id, so an edit cannot be validated against a schema"
  }
  return null
}

export async function editAndReplay(opts: EditReplayOptions): Promise<EditReplayOutcome> {
  const { renderer, registry, profile, row, now } = opts
  const blocked = writeBlockedReason(profile) ?? editBlockedReason(row)
  if (blocked !== null) {
    return { kind: "refused", reason: blocked }
  }
  // Non-null by editBlockedReason above; the schema is fetched before the editor opens so a
  // registry outage costs nothing but a status line.
  const schemaId = row.valueSchemaId as number
  const type = await typeForSchemaId(registry, schemaId)

  const saved = await editInEditor(renderer, editBuffer(row, now()), "message-edit.jsonc")
  if (isEmptyBuffer(saved)) {
    return { kind: "aborted", reason: "the buffer was emptied — nothing produced" }
  }
  const parsed = parse(saved)
  if ("error" in parsed) {
    return { kind: "refused", reason: `the edited buffer is not valid JSON — ${parsed.error}` }
  }

  const edited = coerceToType(type, parsed.value)
  if (stringifyEditable(edited) === stringifyEditable(row.decodedValue)) {
    // Comment-only and whitespace-only saves land here too: what matters is whether the
    // value changed, and if it did not, spec 013's byte-exact path is the honest one.
    return {
      kind: "aborted",
      reason: "the value is unchanged — nothing produced; p replays it byte-exact",
    }
  }
  const violations = [...unknownFields(type, edited), ...validate(type, edited)]
  if (violations.length > 0) {
    return { kind: "invalid", violations }
  }

  const encoded = encode(type, schemaId, edited)
  if ("error" in encoded) {
    return { kind: "refused", reason: `encode failed — ${encoded.error}` }
  }
  const action: WriteAction = {
    kind: "edit-replay",
    topic: row.topic,
    count: 1,
    oldest: row.timestamp,
  }
  const gate = evaluateWrite(profile, action, now())
  if (!gate.allowed) {
    return { kind: "refused", reason: gate.reason }
  }
  return {
    kind: "confirm",
    prompt: gate.prompt,
    action,
    produce: { topic: row.topic, records: [editedRecord(row, encoded.bytes)] },
  }
}

function parse(text: string): { value: unknown } | { error: string } {
  try {
    return { value: parseEditBuffer(text) }
  } catch (failure) {
    return { error: message(failure) }
  }
}

function encode(
  type: avro.Type,
  schemaId: number,
  value: unknown,
): { bytes: Buffer } | { error: string } {
  try {
    return { bytes: encodeWithType(type, schemaId, value) }
  } catch (failure) {
    return { error: message(failure) }
  }
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
