import { describe, expect, test } from "bun:test"
import avro from "avsc"
import type { RawMessage } from "@/types.ts"
import { decodeMessage } from "./decode.ts"
import {
  encodeBySchemaId,
  encodeLatestForSubject,
  encodeWithSchema,
  SchemaValidationError,
  validate,
} from "./encode.ts"
import { longType } from "./long.ts"
import type { LatestSchema, SchemaRegistry } from "./registry.ts"
import { frame } from "./wire.ts"

const RECORD_SCHEMA = JSON.stringify({
  type: "record",
  name: "Event",
  fields: [
    { name: "CustomerId", type: "long" },
    { name: "Tags", type: { type: "array", items: "string" } },
    { name: "Note", type: ["null", "string"], default: null },
  ],
})
// Object form, the shape a real key subject has — the avsc trap decode.ts normalises away.
const LONG_SCHEMA = JSON.stringify({ type: "long" })

const SCHEMAS: Record<number, string> = { 1: LONG_SCHEMA, 30: RECORD_SCHEMA }

const fakeRegistry: SchemaRegistry = {
  async getSchemaById(id: number) {
    const schema = SCHEMAS[id]
    if (!schema) {
      throw new Error(`unknown schema id ${id}`)
    }
    return schema
  },
  async getLatestSchema(subject: string): Promise<LatestSchema | null> {
    if (subject === "orders-value") {
      return { subject, id: 30, version: 4, schema: RECORD_SCHEMA }
    }
    if (subject === "orders-key") {
      return { subject, id: 1, version: 1, schema: LONG_SCHEMA }
    }
    return null
  },
  async getVersionForId(): Promise<number | null> {
    return null
  },
}

const recordType = avro.Type.forSchema(JSON.parse(RECORD_SCHEMA), { registry: { long: longType } })

function raw(overrides: Partial<RawMessage>): RawMessage {
  return {
    topic: "orders",
    partition: 0,
    offset: 0n,
    timestamp: new Date(0),
    key: null,
    value: null,
    headers: {},
    ...overrides,
  }
}

// Above 2^53: Number would round it, so it only round-trips if both halves stay BigInt.
const BIG = 9007199254740993n

describe("encode round trip", () => {
  test("a record re-encodes to the exact original bytes", async () => {
    const original = frame(
      30,
      recordType.toBuffer({ CustomerId: BIG, Tags: ["a", "b"], Note: "hi" }),
    )
    const decoded = await decodeMessage(raw({ value: original }), fakeRegistry)
    const reencoded = await encodeBySchemaId(
      fakeRegistry,
      decoded.valueSchemaId!,
      decoded.decodedValue,
    )
    expect(reencoded.equals(original)).toBe(true)
  })

  test("a bare long key re-encodes to the exact original bytes (the object-form trap)", async () => {
    const original = frame(1, longType.toBuffer(BIG))
    const decoded = await decodeMessage(raw({ key: original }), fakeRegistry)
    expect(decoded.decodedKey).toBe(BIG)
    const reencoded = await encodeBySchemaId(fakeRegistry, decoded.keySchemaId!, decoded.decodedKey)
    expect(reencoded.equals(original)).toBe(true)
  })

  test("a long above 2^53 survives encode then decode", async () => {
    const bytes = encodeWithSchema(LONG_SCHEMA, 1, BIG)
    const decoded = await decodeMessage(raw({ key: bytes }), fakeRegistry)
    expect(typeof decoded.decodedKey).toBe("bigint")
    expect(decoded.decodedKey).toBe(BIG)
    expect(decoded.decodedKey === 9007199254740992n).toBe(false)
  })

  test("the framing is magic 0x00 + big-endian schema id", () => {
    const bytes = encodeWithSchema(LONG_SCHEMA, 30, 1n)
    expect(bytes[0]).toBe(0)
    expect(bytes.readUInt32BE(1)).toBe(30)
  })
})

describe("validation", () => {
  test("a Number where the schema says long is rejected, not silently accepted", () => {
    // 42 is the discriminator for the object-form trap: an unnormalised {"type":"long"}
    // gets avsc's default LongType, which takes Numbers happily — and the next id from
    // that path is a rounded one. Under the BigInt long, only bigints validate.
    expect(() => encodeWithSchema(LONG_SCHEMA, 1, 42)).toThrow(SchemaValidationError)
    expect(() => encodeWithSchema(LONG_SCHEMA, 1, Number.MAX_SAFE_INTEGER)).toThrow(
      SchemaValidationError,
    )
  })

  test("a violation names the offending field path", () => {
    const error = (() => {
      try {
        encodeWithSchema(RECORD_SCHEMA, 30, { CustomerId: "nope", Tags: [], Note: null })
        return null
      } catch (caught) {
        return caught as SchemaValidationError
      }
    })()
    expect(error).toBeInstanceOf(SchemaValidationError)
    expect(error!.violations[0]!.path).toBe("CustomerId")
    expect(error!.message).toContain("CustomerId")
  })

  test("a missing required field is a violation, not a default", () => {
    const violations = validate(recordType, { Tags: [], Note: null })
    expect(violations.map((v) => v.path)).toContain("CustomerId")
  })

  test("a valid record has no violations", () => {
    expect(validate(recordType, { CustomerId: BIG, Tags: [], Note: null })).toEqual([])
  })

  test("the BigInt message of a violation is not stringified through JSON", () => {
    const error = new SchemaValidationError([{ path: "Id", value: BIG, expected: "int" }])
    expect(error.message).toContain("9007199254740993")
  })
})

describe("encodeLatestForSubject", () => {
  test("encodes against the subject's latest id", async () => {
    const encoded = await encodeLatestForSubject(fakeRegistry, "orders-value", {
      CustomerId: BIG,
      Tags: [],
      Note: null,
    })
    expect(encoded.schemaId).toBe(30)
    expect(encoded.version).toBe(4)
    const decoded = await decodeMessage(raw({ value: encoded.bytes }), fakeRegistry)
    expect((decoded.decodedValue as { CustomerId: bigint }).CustomerId).toBe(BIG)
  })

  test("an unregistered subject throws rather than producing unframed bytes", async () => {
    await expect(encodeLatestForSubject(fakeRegistry, "ghost-value", 1n)).rejects.toThrow(
      "no schema registered for subject ghost-value",
    )
  })
})
