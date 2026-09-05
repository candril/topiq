import { describe, expect, test } from "bun:test"
import type { DecodedMessage } from "@/types.ts"
import { editBuffer, isEmptyBuffer, parseEditBuffer, stripLeadingComments } from "./editBuffer.ts"

const BIG = 9007199254740993n

function row(over: Partial<DecodedMessage> = {}): DecodedMessage {
  return {
    topic: "dg-orders",
    partition: 2,
    offset: 981n,
    timestamp: new Date("2026-08-28T10:00:00Z"),
    key: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x09, 0x0a]),
    value: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x2a]),
    headers: { traceparent: Buffer.from("00-abc-01") },
    decodedKey: 5n,
    decodedValue: { CustomerId: BIG, Blob: Buffer.alloc(20, 0xab) },
    valueSchemaId: 42,
    ...over,
  }
}

const NOW = new Date("2026-08-28T12:14:00Z")

describe("editBuffer", () => {
  test("names the topic, coordinates and the schema id the edit is validated against", () => {
    const text = editBuffer(row(), NOW)
    expect(text).toContain("dg-orders")
    expect(text).toContain("offset 981")
    expect(text).toContain("value id 42")
  })

  test("the key and headers are comments, not editable content", () => {
    const text = editBuffer(row(), NOW)
    expect(text).toContain("// key       5 (re-produced as its original bytes)")
    expect(text).toContain("traceparent=00-abc-01")
    expect(parseEditBuffer(text)).toEqual({
      CustomerId: BIG,
      Blob: `0x${"ab".repeat(20)}`,
    })
  })

  test("the body is the value alone, and it parses", () => {
    expect(() => parseEditBuffer(editBuffer(row(), NOW))).not.toThrow()
  })

  test("a BigInt above 2^53 survives out and back with exact digits", () => {
    const parsed = parseEditBuffer(editBuffer(row(), NOW)) as { CustomerId: bigint }
    expect(parsed.CustomerId).toBe(BIG)
    expect(parsed.CustomerId === 9007199254740992n).toBe(false)
  })

  test("bytes are written whole, not as the truncated reading preview", () => {
    const text = editBuffer(row(), NOW)
    expect(text).toContain(`"0x${"ab".repeat(20)}"`)
    expect(text).not.toContain("(20 bytes)")
  })

  test("a message with no headers says so rather than showing an empty list", () => {
    expect(editBuffer(row({ headers: {} }), NOW)).toContain("// headers   none")
  })
})

describe("stripLeadingComments", () => {
  test("removes the header block and nothing else", () => {
    expect(stripLeadingComments('// a\n// b\n\n{"x": 1}\n')).toBe('{"x": 1}\n')
  })

  test("a // inside a string is data, not a comment", () => {
    const text = '// head\n{"url": "https://x/y"}\n'
    expect(parseEditBuffer(text)).toEqual({ url: "https://x/y" })
  })

  test("a buffer with no comments is returned as it stands", () => {
    expect(stripLeadingComments('{"x": 1}')).toBe('{"x": 1}')
  })
})

describe("isEmptyBuffer", () => {
  test("header only counts as empty — the body was deleted", () => {
    expect(isEmptyBuffer("// topiq — edit and replay\n//\n")).toBe(true)
  })

  test("a body makes it non-empty", () => {
    expect(isEmptyBuffer("// head\nnull\n")).toBe(false)
  })

  test("a truly empty file is empty", () => {
    expect(isEmptyBuffer("")).toBe(true)
  })
})

describe("parseEditBuffer", () => {
  test("integers past 2^53 are BigInt; smaller ones stay Numbers for the schema walk", () => {
    const parsed = parseEditBuffer('{"big": 9007199254740993, "small": 4}') as Record<
      string,
      unknown
    >
    expect(parsed.big).toBe(BIG)
    expect(parsed.small).toBe(4)
  })

  test("invalid JSON throws, so the caller can quote the parser's own message", () => {
    expect(() => parseEditBuffer("// head\n{oops}")).toThrow()
  })
})
