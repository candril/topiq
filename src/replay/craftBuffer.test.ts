import { describe, expect, test } from "bun:test"
import type { LatestSchema } from "@/schema/registry.ts"
import { craftBuffer, parseCraftBuffer } from "./craftBuffer.ts"

const VALUE: LatestSchema = {
  subject: "dg-orders-value",
  id: 1234,
  version: 7,
  schema: "{}",
}
const KEY: LatestSchema = { subject: "dg-orders-key", id: 12, version: 2, schema: "{}" }

function buffer(over: Partial<Parameters<typeof craftBuffer>[0]> = {}): string {
  return craftBuffer({
    topic: "dg-orders",
    value: VALUE,
    key: null,
    skeleton: { key: null, value: { Id: 0n, Blob: Buffer.from([0x1f, 0x8b]) }, headers: {} },
    notes: [{ path: "Note", branches: ["null", "string"] }],
    ...over,
  })
}

describe("craftBuffer", () => {
  test("the header names the subject and version the payload will be encoded against", () => {
    expect(buffer()).toContain("dg-orders-value v7 (id 1234)")
  })

  test("an unregistered key subject is stated, not left to be discovered on save", () => {
    expect(buffer()).toContain("dg-orders-key is not registered")
  })

  test("a registered key subject shows its own version", () => {
    expect(buffer({ key: KEY })).toContain("dg-orders-key v2 (id 12)")
  })

  test("union positions are listed, since JSON has no room for inline comments", () => {
    expect(buffer()).toContain("//   Note: null | string")
  })

  test("a BigInt is bare digits and bytes are full hex — both read back by schema", () => {
    const body = buffer()
    expect(body).toContain('"Id": 0')
    expect(body).toContain('"Blob": "0x1f8b"')
  })

  test("what it writes is what it reads: the skeleton survives the round trip", () => {
    const envelope = parseCraftBuffer(buffer())
    expect(envelope.value).toEqual({ Id: 0, Blob: "0x1f8b" })
    expect(envelope.key).toBeNull()
    expect(envelope.headers).toEqual({})
  })
})

describe("parseCraftBuffer", () => {
  test("the comment header is stripped, whoever wrote it", () => {
    const envelope = parseCraftBuffer('// mine\n// and more\n{"value": {"a": 1}}')
    expect(envelope.value).toEqual({ a: 1 })
  })

  test("a missing value is refused — there would be nothing to produce", () => {
    expect(() => parseCraftBuffer('{"key": "k"}')).toThrow('no "value"')
  })

  test("a mistyped member is named rather than dropped", () => {
    expect(() => parseCraftBuffer('{"vlaue": {}}')).toThrow('no member "vlaue"')
  })

  test("a bare value with no envelope is refused rather than half-read", () => {
    expect(() => parseCraftBuffer('{"Id": 1}')).toThrow('no member "Id"')
    expect(() => parseCraftBuffer("[1, 2]")).toThrow("must hold an object")
  })

  test("an absent key member means no key, an absent headers member means none", () => {
    const envelope = parseCraftBuffer('{"value": 1}')
    expect(envelope.key).toBeNull()
    expect(envelope.headers).toEqual({})
  })

  test("headers must be an object", () => {
    expect(() => parseCraftBuffer('{"value": 1, "headers": "x"}')).toThrow("object of strings")
  })

  test("an integer past 2^53 survives the read as a BigInt", () => {
    const envelope = parseCraftBuffer('{"value": {"Id": 9007199254740993}}')
    expect((envelope.value as { Id: bigint }).Id).toBe(9007199254740993n)
  })
})
