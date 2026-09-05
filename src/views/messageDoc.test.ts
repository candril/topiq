import { describe, expect, test } from "bun:test"
import type { DecodedMessage } from "@/types.ts"
import { editorDocument, headerDisplay, hexDump } from "./messageDoc.ts"

const NOW = new Date("2026-08-27T12:00:00.000Z")

function message(overrides: Partial<DecodedMessage> = {}): DecodedMessage {
  return {
    topic: "orders.v1",
    partition: 3,
    offset: 9007199254740993n,
    timestamp: new Date("2026-08-27T10:00:00.123Z"),
    key: Buffer.from("k1"),
    value: Buffer.from("{}"),
    headers: {},
    decodedKey: "k1",
    decodedValue: { CustomerId: 9007199254740993n },
    ...overrides,
  }
}

describe("headerDisplay", () => {
  test("valid printable UTF-8 renders as text", () => {
    expect(headerDisplay(Buffer.from("trace-123"))).toBe("trace-123")
    expect(headerDisplay(Buffer.from("héllo"))).toBe("héllo")
  })

  test("invalid UTF-8 and control characters fall back to hex", () => {
    expect(headerDisplay(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe("0xdeadbeef")
    expect(headerDisplay(Buffer.from("a\nb"))).toBe("0x610a62")
  })
})

describe("hexDump", () => {
  test("renders offset, hex and ascii columns", () => {
    const lines = hexDump(Buffer.from("ABC\x00"))
    expect(lines).toEqual([`00000000  ${"41 42 43 00".padEnd(47)}  |ABC.|`])
  })

  test("caps the dump and reports the remainder", () => {
    const lines = hexDump(Buffer.alloc(40), 32)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe("… 8 more bytes")
  })
})

describe("editorDocument", () => {
  test("carries metadata comments and the lossless body", () => {
    const doc = editorDocument(message({ headers: { trace: Buffer.from("t1") } }), NOW)
    expect(doc).toContain("// topic     orders.v1")
    expect(doc).toContain("// partition p3 · offset 9007199254740993")
    expect(doc).toContain("// timestamp 2026-08-27 10:00:00.123 UTC · 1h 59m ago")
    expect(doc).toContain('"CustomerId": 9007199254740993')
    expect(doc).toContain('"trace": "t1"')
  })

  test("tombstone renders as a null value, not an omission", () => {
    const doc = editorDocument(message({ value: null, decodedValue: null }), NOW)
    expect(doc).toContain('"value": null')
  })

  test("decode failure carries the error and raw hex, never a half-decoded value", () => {
    const doc = editorDocument(
      message({ decodeError: "unknown magic byte", value: Buffer.from([0x01, 0x02]) }),
      NOW,
    )
    expect(doc).toContain('"decodeError": "unknown magic byte"')
    expect(doc).toContain("01 02")
    expect(doc).not.toContain('"CustomerId"')
  })
})
