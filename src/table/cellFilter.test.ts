import { describe, expect, test } from "bun:test"
import { compile } from "@/filter/compile.ts"
import type { DecodedMessage } from "@/types.ts"
import { cellFilterTerm, withTerm } from "./cellFilter.ts"

function row(value: unknown, overrides: Partial<DecodedMessage> = {}): DecodedMessage {
  return {
    topic: "t",
    partition: 3,
    offset: 9007199254740993n,
    timestamp: new Date("2026-08-27T10:00:00.123Z"),
    key: Buffer.from("k"),
    value: Buffer.from("v"),
    headers: {},
    decodedKey: 42n,
    decodedValue: value,
    ...overrides,
  } as DecodedMessage
}

describe("cellFilterTerm", () => {
  test("a value column becomes a value.<path> term", () => {
    expect(cellFilterTerm(row({ EventType: "Updated" }), "EventType")).toBe(
      "value.EventType:Updated",
    )
    expect(cellFilterTerm(row({ Entity: { Id: 7n } }), "value.Entity.Id")).toBe("value.Entity.Id:7")
  })

  test("BigInts keep every digit — the term must match the row it came from", () => {
    const message = row({ CustomerId: 9007199254740993n })
    const term = cellFilterTerm(message, "CustomerId")
    expect(term).toBe("value.CustomerId:9007199254740993")
    expect(compile(term!).predicate(message)).toBe(true)
  })

  test("envelope columns filter on themselves", () => {
    const message = row({})
    expect(cellFilterTerm(message, "partition")).toBe("partition:3")
    expect(cellFilterTerm(message, "offset")).toBe("offset:9007199254740993")
    expect(cellFilterTerm(message, "timestamp")).toBe("timestamp:2026-08-27T10:00:00.123Z")
    for (const path of ["partition", "offset", "timestamp"]) {
      expect(compile(cellFilterTerm(message, path)!).predicate(message)).toBe(true)
    }
  })

  test("values needing quotes get them, and still match", () => {
    const message = row({ Note: "two words" })
    const term = cellFilterTerm(message, "Note")
    expect(term).toBe('value.Note:"two words"')
    expect(compile(term!).predicate(message)).toBe(true)
  })

  test("null is filterable; absent, subtrees and undecodable rows are not", () => {
    expect(cellFilterTerm(row({ Note: null }), "Note")).toBe("value.Note:null")
    expect(cellFilterTerm(row({}), "Missing")).toBeNull()
    expect(cellFilterTerm(row({ Entity: { Id: 1n } }), "Entity")).toBeNull()
    expect(cellFilterTerm(row({ Tags: ["a"] }), "Tags")).toBeNull()
    expect(cellFilterTerm(row(null, { decodeError: "boom" }), "EventType")).toBeNull()
    // A tombstone still has envelope columns to filter on.
    expect(cellFilterTerm(row(null, { value: null }), "partition")).toBe("partition:3")
  })
})

describe("withTerm", () => {
  test("appends with the grammar's implicit AND", () => {
    expect(withTerm("", "partition:3")).toBe("partition:3")
    expect(withTerm("offset>5", "partition:3")).toBe("offset>5 partition:3")
  })

  test("never duplicates a term already present", () => {
    expect(withTerm("partition:3", "partition:3")).toBe("partition:3")
    expect(withTerm("offset>5 partition:3", "partition:3")).toBe("offset>5 partition:3")
  })

  test("a JS predicate is left alone — it is not a term list", () => {
    expect(withTerm("=key > 1n", "partition:3")).toBe("=key > 1n")
  })
})
