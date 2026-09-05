import { describe, expect, test } from "bun:test"
import type { DecodedMessage } from "@/types.ts"
import { cycleSort, sortRows, UNSORTED } from "./sort.ts"

function row(offset: bigint, value: unknown, overrides: Partial<DecodedMessage> = {}) {
  return {
    topic: "t",
    partition: 0,
    offset,
    timestamp: new Date(0),
    key: null,
    value: Buffer.from("x"),
    headers: {},
    decodedKey: null,
    decodedValue: value,
    ...overrides,
  } as DecodedMessage
}

const offsets = (rows: readonly DecodedMessage[]) => rows.map((r) => Number(r.offset))

describe("cycleSort", () => {
  test("asc → desc → unsorted on the same column", () => {
    const a = cycleSort(UNSORTED, "Id")
    expect(a).toEqual({ path: "Id", direction: "asc" })
    const b = cycleSort(a, "Id")
    expect(b).toEqual({ path: "Id", direction: "desc" })
    expect(cycleSort(b, "Id")).toEqual(UNSORTED)
  })

  test("a different column starts fresh at asc", () => {
    expect(cycleSort({ path: "Id", direction: "desc" }, "Name")).toEqual({
      path: "Name",
      direction: "asc",
    })
  })
})

describe("sortRows", () => {
  test("BigInts above 2^53 order exactly — the whole point (nfr/006)", () => {
    const rows = [
      row(1n, { Id: 9007199254740993n }),
      row(2n, { Id: 9007199254740992n }),
      row(3n, { Id: 9007199254740994n }),
    ]
    expect(offsets(sortRows(rows, { path: "Id", direction: "asc" }))).toEqual([2, 1, 3])
    // Through Number these three collapse to two values and the order would be arbitrary.
    expect(Number(9007199254740993n)).toBe(Number(9007199254740992n))
  })

  test("descending reverses, and absent values stay last in both directions", () => {
    const rows = [row(1n, { Id: 2n }), row(2n, {}), row(3n, { Id: 1n })]
    expect(offsets(sortRows(rows, { path: "Id", direction: "asc" }))).toEqual([3, 1, 2])
    expect(offsets(sortRows(rows, { path: "Id", direction: "desc" }))).toEqual([1, 3, 2])
  })

  test("null is present and sorts among values, unlike absent", () => {
    const rows = [row(1n, { Id: null }), row(2n, {}), row(3n, { Id: 5n })]
    const sorted = offsets(sortRows(rows, { path: "Id", direction: "asc" }))
    expect(sorted[2]).toBe(2) // absent last
    expect(sorted).toContain(1) // null still placed
  })

  test("equal values keep arrival order (stable)", () => {
    const rows = [row(5n, { Id: 1n }), row(6n, { Id: 1n }), row(7n, { Id: 1n })]
    expect(offsets(sortRows(rows, { path: "Id", direction: "asc" }))).toEqual([5, 6, 7])
    expect(offsets(sortRows(rows, { path: "Id", direction: "desc" }))).toEqual([5, 6, 7])
  })

  test("tombstones and undecodable rows sort as absent, never crash", () => {
    const rows = [
      row(1n, { Id: 2n }),
      row(2n, null, { value: null }),
      row(3n, null, { decodeError: "boom" }),
    ]
    expect(offsets(sortRows(rows, { path: "Id", direction: "asc" }))).toEqual([1, 2, 3])
  })

  test("a bigint and a number compare exactly across the boundary", () => {
    const rows = [row(1n, { Id: 9007199254740993n }), row(2n, { Id: 9007199254740992 })]
    expect(offsets(sortRows(rows, { path: "Id", direction: "asc" }))).toEqual([2, 1])
  })

  test("unsorted returns arrival order untouched", () => {
    const rows = [row(3n, { Id: 1n }), row(1n, { Id: 2n })]
    expect(sortRows(rows, UNSORTED)).toBe(rows)
  })

  test("strings sort lexicographically", () => {
    const rows = [row(1n, { Name: "beta" }), row(2n, { Name: "alpha" })]
    expect(offsets(sortRows(rows, { path: "Name", direction: "asc" }))).toEqual([2, 1])
  })
})

describe("envelope columns (spec 024)", () => {
  const rows = [
    row(9007199254740995n, { Id: 1n }, { partition: 2, timestamp: new Date(3000) }),
    row(9007199254740993n, { Id: 2n }, { partition: 0, timestamp: new Date(1000) }),
    row(9007199254740994n, { Id: 3n }, { partition: 1, timestamp: new Date(2000) }),
  ]

  test("offset sorts exactly above 2^53, not through Number", () => {
    const asc = sortRows(rows, { path: "offset", direction: "asc" })
    expect(asc.map((r) => r.offset)).toEqual([
      9007199254740993n,
      9007199254740994n,
      9007199254740995n,
    ])
  })

  test("timestamp and partition are selectable sort keys", () => {
    expect(
      sortRows(rows, { path: "timestamp", direction: "asc" }).map((r) => r.timestamp.getTime()),
    ).toEqual([1000, 2000, 3000])
    expect(
      sortRows(rows, { path: "partition", direction: "desc" }).map((r) => r.partition),
    ).toEqual([2, 1, 0])
  })

  test("a value column may be addressed with or without the value. prefix", () => {
    const bare = sortRows(rows, { path: "Id", direction: "asc" }).map((r) => r.partition)
    const prefixed = sortRows(rows, { path: "value.Id", direction: "asc" }).map((r) => r.partition)
    expect(prefixed).toEqual(bare)
  })

  test("envelope columns sort even when the payload failed to decode", () => {
    const broken = [
      row(2n, null, { decodeError: "boom", partition: 5 }),
      row(1n, null, { decodeError: "boom", partition: 4 }),
    ]
    expect(sortRows(broken, { path: "offset", direction: "asc" }).map((r) => r.offset)).toEqual([
      1n,
      2n,
    ])
  })
})
