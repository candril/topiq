import { describe, expect, test } from "bun:test"
import { flattenFields } from "./flatten.ts"

const BIG = 9007199254740993n

describe("flattenFields", () => {
  test("record fields become dotted paths with lossless displays", () => {
    const fields = flattenFields({ CustomerId: BIG, Name: "x" })
    expect(fields).toEqual([
      { path: "CustomerId", display: "9007199254740993" },
      { path: "Name", display: '"x"' },
    ])
  })

  test("nested records flatten to a.b within the depth cap", () => {
    const fields = flattenFields({ a: { b: 1n } })
    expect(fields).toEqual([{ path: "a.b", display: "1" }])
  })

  test("nesting beyond the cap is summarised, not expanded", () => {
    const fields = flattenFields({ a: { b: { c: 1n, d: 2n } } })
    expect(fields).toEqual([{ path: "a.b", display: "{2 fields}" }])
  })

  test("a larger maxDepth expands further", () => {
    const fields = flattenFields({ a: { b: { c: 1n } } }, { maxDepth: 3 })
    expect(fields).toEqual([{ path: "a.b.c", display: "1" }])
  })

  test("arrays are summarised, empty array stays [] — never NULL", () => {
    const fields = flattenFields({ Tags: [], Items: [1, 2, 3] })
    expect(fields).toEqual([
      { path: "Tags", display: "[]" },
      { path: "Items", display: "[3 items]" },
    ])
  })

  test("null field is a present path; absent field yields no path at all", () => {
    expect(flattenFields({ a: null })).toEqual([{ path: "a", display: "null" }])
    expect(flattenFields({})).toEqual([])
  })

  test("empty nested record displays as {}, distinct from null", () => {
    const fields = flattenFields({ a: {}, b: null })
    expect(fields).toEqual([
      { path: "a", display: "{}" },
      { path: "b", display: "null" },
    ])
  })

  test("tombstone-safe: null root renders one null column, never throws", () => {
    expect(flattenFields(null)).toEqual([{ path: "", display: "null" }])
  })

  test("scalar root becomes a single pathless field", () => {
    expect(flattenFields(BIG)).toEqual([{ path: "", display: "9007199254740993" }])
    expect(flattenFields("plain")).toEqual([{ path: "", display: '"plain"' }])
  })

  test("array root is summarised", () => {
    expect(flattenFields([1, 2])).toEqual([{ path: "", display: "[2 items]" }])
    expect(flattenFields([])).toEqual([{ path: "", display: "[]" }])
  })

  test("buffer root and buffer fields render as hex preview", () => {
    expect(flattenFields(Buffer.from([0x01]))).toEqual([{ path: "", display: "0x01" }])
    expect(flattenFields({ raw: Buffer.from([0xff]) })).toEqual([{ path: "raw", display: "0xff" }])
  })
})
