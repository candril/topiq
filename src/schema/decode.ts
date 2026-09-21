import type { DecodedMessage, RawMessage } from "@/types.ts"
import { schemaJsonForId, typeForSchemaId } from "./avroType.ts"
import { applyLogicalDates } from "./logical.ts"
import { parseJsonLossless } from "./jsonFallback.ts"
import type { SchemaFetcher } from "./registry.ts"
import { body, hasWireHeader, readSchemaId } from "./wire.ts"

async function decodeField(
  buf: Buffer,
  registry: SchemaFetcher,
): Promise<{ value: unknown; schemaId?: number }> {
  if (hasWireHeader(buf)) {
    const schemaId = readSchemaId(buf)
    const type = await typeForSchemaId(registry, schemaId)
    // Declared dates are lifted after avsc is done, never inside it (spec 031): a logical
    // type registered with avsc would build its underlying long through avsc's own
    // Number-based LongType, losing precision before the annotation was ever read.
    const decoded = type.fromBuffer(body(buf))
    const schema = await schemaJsonForId(registry, schemaId)
    return { value: applyLogicalDates(schema, decoded), schemaId }
  }
  // Not Confluent-framed: try UTF-8 JSON, then plain UTF-8, else keep the raw buffer.
  // The JSON path is BigInt-safe (nfr/006) — a plain-JSON topic's int64 ids must not be
  // rounded on the way in.
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf)
    try {
      return { value: parseJsonLossless(text) }
    } catch {
      return { value: text }
    }
  } catch {
    return { value: buf }
  }
}

/** Lift a raw message to its decoded form. Never throws: a failed decode degrades to
 *  metadata + raw bytes with the error attached (nfr/004). */
export async function decodeMessage(
  raw: RawMessage,
  registry: SchemaFetcher,
): Promise<DecodedMessage> {
  try {
    const key = raw.key ? await decodeField(raw.key, registry) : { value: null }
    const value = raw.value ? await decodeField(raw.value, registry) : { value: null }
    return {
      ...raw,
      decodedKey: key.value,
      decodedValue: value.value,
      keySchemaId: key.schemaId,
      valueSchemaId: value.schemaId,
    }
  } catch (error) {
    return {
      ...raw,
      decodedKey: null,
      decodedValue: null,
      decodeError: error instanceof Error ? error.message : String(error),
    }
  }
}
