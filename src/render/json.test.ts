import { describe, expect, test } from "bun:test"
import {
  bytesPreview,
  hexLiteral,
  stringify,
  stringifyEditable,
  stringifyPretty,
  summarize,
} from "./json.ts"

// One above 2^53: Number would round it to ...992 (nfr/006).
const BIG = 9007199254740993n

describe("stringify", () => {
  test("BigInt above 2^53 renders full digits — unquoted, no n suffix", () => {
    expect(stringify(BIG)).toBe("9007199254740993")
    expect(stringify(BIG)).not.toContain("n")
    expect(stringify(BIG)).not.toContain('"')
  })

  test("BigInt nested in records and arrays keeps exact digits", () => {
    expect(stringify({ id: BIG })).toBe('{"id":9007199254740993}')
    expect(stringify([BIG, 1n])).toBe("[9007199254740993,1]")
  })

  test("negative BigInt", () => {
    expect(stringify(-BIG)).toBe("-9007199254740993")
  })

  test("64-bit extremes render exactly", () => {
    expect(stringify(9223372036854775807n)).toBe("9223372036854775807")
    expect(stringify(-9223372036854775808n)).toBe("-9223372036854775808")
  })

  test("empty array, empty object and null are three distinct renderings", () => {
    expect(stringify([])).toBe("[]")
    expect(stringify({})).toBe("{}")
    expect(stringify(null)).toBe("null")
  })

  test("null field is present, absent field is absent", () => {
    expect(stringify({ a: null })).toBe('{"a":null}')
    expect(stringify({})).toBe("{}")
  })

  test("undefined is distinct from null", () => {
    expect(stringify(undefined)).toBe("undefined")
  })

  test("tombstone-safe: top-level null never throws", () => {
    expect(() => stringify(null)).not.toThrow()
  })

  test("strings are quoted and escaped", () => {
    expect(stringify('he"y\n')).toBe('"he\\"y\\n"')
    expect(stringify("")).toBe('""')
  })

  test("string 'null' stays distinguishable from null", () => {
    expect(stringify("null")).toBe('"null"')
  })

  test("numbers and booleans", () => {
    expect(stringify(1.5)).toBe("1.5")
    expect(stringify(true)).toBe("true")
    expect(stringify(false)).toBe("false")
  })

  test("buffers render as hex preview", () => {
    expect(stringify(Buffer.from([0xff, 0xfe, 0x01]))).toBe("0xfffe01")
  })

  test("dates render as quoted ISO", () => {
    expect(stringify(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"')
  })

  test("nested structures render compact and lossless", () => {
    expect(stringify({ a: [1n, { b: [] }], c: null })).toBe('{"a":[1,{"b":[]}],"c":null}')
  })

  test("a cycle degrades to … instead of hanging", () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(stringify(loop)).toBe('{"self":…}')
  })
})

describe("bytesPreview", () => {
  test("short buffer shows all bytes", () => {
    expect(bytesPreview(Buffer.from([0xde, 0xad]))).toBe("0xdead")
  })

  test("long buffer truncates with a byte count", () => {
    const bytes = Buffer.alloc(20, 0xab)
    expect(bytesPreview(bytes)).toBe(`0x${"ab".repeat(16)}… (20 bytes)`)
  })

  test("empty buffer", () => {
    expect(bytesPreview(Buffer.alloc(0))).toBe("0x")
  })

  test("Buffer subarray previews its own window, not the parent allocation", () => {
    const parent = Buffer.from([1, 2, 3, 4])
    expect(bytesPreview(parent.subarray(1, 3))).toBe("0x0203")
  })
})

describe("hexLiteral", () => {
  test("never truncates — the whole point next to bytesPreview", () => {
    const bytes = Buffer.alloc(40, 0xab)
    expect(hexLiteral(bytes)).toBe(`0x${"ab".repeat(40)}`)
    expect(hexLiteral(bytes)).not.toContain("…")
  })

  test("empty buffer is 0x, which reads back as empty bytes", () => {
    expect(hexLiteral(Buffer.alloc(0))).toBe("0x")
  })

  test("a subarray writes its own window", () => {
    expect(hexLiteral(Buffer.from([1, 2, 3, 4]).subarray(1, 3))).toBe("0x0203")
  })
})

describe("stringifyEditable", () => {
  test("BigInt stays a bare literal, so the buffer is valid JSON and exact", () => {
    expect(stringifyEditable({ id: BIG })).toBe(`{\n  "id": 9007199254740993\n}`)
  })

  test("bytes become a quoted full-hex string, unlike the reading form", () => {
    const bytes = Buffer.alloc(20, 0xab)
    expect(stringifyEditable({ blob: bytes })).toContain(`"0x${"ab".repeat(20)}"`)
    // stringifyPretty truncates at 16 bytes: writing *that* into an editable buffer would
    // silently shorten the field on save (spec 014).
    expect(stringifyPretty({ blob: bytes })).toContain("…")
  })

  test("the whole document parses as JSON once BigInts are read back by type", () => {
    const text = stringifyEditable({ a: [1, { b: [] }], c: null, d: "x" })
    expect(() => JSON.parse(text) as unknown).not.toThrow()
  })

  test("empty containers stay distinct from null", () => {
    expect(stringifyEditable({ a: [], b: {}, c: null })).toBe(
      `{\n  "a": [],\n  "b": {},\n  "c": null\n}`,
    )
  })
})

describe("summarize", () => {
  test("arrays summarise by count, empty stays []", () => {
    expect(summarize([])).toBe("[]")
    expect(summarize([1])).toBe("[1 item]")
    expect(summarize([1, 2, 3])).toBe("[3 items]")
  })

  test("records summarise by field count, empty stays {}", () => {
    expect(summarize({})).toBe("{}")
    expect(summarize({ a: 1 })).toBe("{1 field}")
    expect(summarize({ a: 1, b: 2 })).toBe("{2 fields}")
  })

  test("scalars fall through to stringify", () => {
    expect(summarize(BIG)).toBe("9007199254740993")
    expect(summarize(null)).toBe("null")
  })
})
