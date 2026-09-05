import { describe, expect, test } from "bun:test"
import avro from "avsc"
import type { RawMessage } from "@/types.ts"
import { decodeMessage } from "./decode.ts"
import { longType } from "./long.ts"
import type { SchemaFetcher } from "./registry.ts"

const RECORD_SCHEMA = JSON.stringify({
  type: "record",
  name: "Event",
  fields: [
    { name: "CustomerId", type: "long" },
    { name: "Tags", type: { type: "array", items: "string" } },
    { name: "Note", type: ["null", "string"], default: null },
  ],
})
const LONG_SCHEMA = JSON.stringify({ type: "long" })

const fakeRegistry: SchemaFetcher = {
  async getSchemaById(id: number) {
    if (id === 1) {
      return LONG_SCHEMA
    }
    if (id === 30) {
      return RECORD_SCHEMA
    }
    throw new Error(`unknown schema id ${id}`)
  },
}

function frame(schemaId: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(schemaId, 1)
  return Buffer.concat([header, payload])
}

function raw(overrides: Partial<RawMessage>): RawMessage {
  return {
    topic: "t",
    partition: 0,
    offset: 0n,
    timestamp: new Date(0),
    key: null,
    value: null,
    headers: {},
    ...overrides,
  }
}

const recordType = avro.Type.forSchema(JSON.parse(RECORD_SCHEMA), { registry: { long: longType } })

// A customer id above 2^53: Number would round it. The whole point (nfr/006).
const BIG = 9007199254740993n

describe("decodeMessage", () => {
  test("record long field above 2^53 survives as exact BigInt", async () => {
    const value = frame(30, recordType.toBuffer({ CustomerId: BIG, Tags: [], Note: null }))
    const decoded = await decodeMessage(raw({ value }), fakeRegistry)
    const entity = decoded.decodedValue as { CustomerId: bigint; Tags: string[] }
    expect(typeof entity.CustomerId).toBe("bigint")
    expect(entity.CustomerId).toBe(BIG)
    expect(entity.CustomerId === 9007199254740992n).toBe(false)
    expect(decoded.valueSchemaId).toBe(30)
  })

  test("bare top-level long key decodes as BigInt (the avsc object-form trap)", async () => {
    const key = frame(1, longType.toBuffer(BIG))
    const decoded = await decodeMessage(raw({ key }), fakeRegistry)
    expect(typeof decoded.decodedKey).toBe("bigint")
    expect(decoded.decodedKey).toBe(BIG)
    expect(decoded.keySchemaId).toBe(1)
  })

  test("empty array stays [], not NULL", async () => {
    const value = frame(30, recordType.toBuffer({ CustomerId: 1n, Tags: [], Note: null }))
    const decoded = await decodeMessage(raw({ value }), fakeRegistry)
    expect((decoded.decodedValue as { Tags: string[] }).Tags).toEqual([])
  })

  test("tombstone: null value is first-class, not an error", async () => {
    const key = frame(1, longType.toBuffer(42n))
    const decoded = await decodeMessage(raw({ key, value: null }), fakeRegistry)
    expect(decoded.decodedValue).toBeNull()
    expect(decoded.decodeError).toBeUndefined()
  })

  test("non-Avro UTF-8 JSON falls back to parsed JSON", async () => {
    const decoded = await decodeMessage(raw({ value: Buffer.from('{"plain":true}') }), fakeRegistry)
    expect(decoded.decodedValue).toEqual({ plain: true })
    expect(decoded.valueSchemaId).toBeUndefined()
  })

  test("non-UTF-8 bytes fall back to the raw buffer", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x01])
    const decoded = await decodeMessage(raw({ value: bytes }), fakeRegistry)
    expect(decoded.decodedValue).toEqual(bytes)
  })

  test("unknown schema id degrades to decodeError, never throws", async () => {
    const decoded = await decodeMessage(raw({ value: frame(99, Buffer.from([2])) }), fakeRegistry)
    expect(decoded.decodeError).toContain("unknown schema id 99")
    expect(decoded.value).not.toBeNull()
  })

  test("longType round-trips: encode BigInt -> decode BigInt", () => {
    expect(longType.fromBuffer(longType.toBuffer(BIG))).toBe(BIG)
  })
})
