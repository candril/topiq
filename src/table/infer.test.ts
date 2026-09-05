import { describe, expect, test } from "bun:test"
import { fieldMap, fitColumns, inferColumns } from "./infer.ts"

describe("fieldMap", () => {
  test("BigInt renders lossless", () => {
    const map = fieldMap({ id: 9007199254740993n })
    expect(map.get("id")).toBe("9007199254740993")
  })

  test("empty array is [] and null is null — never conflated with absent", () => {
    const map = fieldMap({ tags: [], gone: null })
    expect(map.get("tags")).toBe("[]")
    expect(map.get("gone")).toBe("null")
    expect(map.has("missing")).toBe(false)
  })

  test("scalar root gets the pathless column", () => {
    expect(fieldMap("hello").get("")).toBe('"hello"')
  })
})

describe("inferColumns", () => {
  test("samples the whole window: union of mixed subtypes, common fields first", () => {
    const a = fieldMap({ type: "created", customerId: 1n })
    const b = fieldMap({ type: "deleted", reason: "gdpr" })
    const columns = inferColumns([a, a, b])
    expect(columns.map((c) => c.path)).toEqual(["type", "customerId", "reason"])
  })

  test("first-seen order breaks frequency ties — stable across renders", () => {
    const samples = [fieldMap({ b: 1, a: 2 }), fieldMap({ b: 3, a: 4 })]
    expect(inferColumns(samples).map((c) => c.path)).toEqual(["b", "a"])
    expect(inferColumns(samples).map((c) => c.path)).toEqual(["b", "a"])
  })

  test("respects maxColumns, keeping the most common", () => {
    const wide = fieldMap({ a: 1, b: 2, c: 3 })
    const narrow = fieldMap({ a: 1 })
    const columns = inferColumns([wide, narrow], { maxColumns: 2 })
    expect(columns.map((c) => c.path)).toEqual(["a", "b"])
  })

  test("nested paths come dotted from the flattener", () => {
    const columns = inferColumns([fieldMap({ meta: { source: "web" } })])
    expect(columns[0]?.path).toBe("meta.source")
  })

  test("width tracks the widest sample, clamped", () => {
    const columns = inferColumns([fieldMap({ id: "x".repeat(100) })])
    expect(columns[0]?.width).toBe(28)
    const tiny = inferColumns([fieldMap({ id: 1 })])
    // Header length floors the width so the title never truncates below the minimum.
    expect(tiny[0]?.width).toBe(4)
  })

  test("pathless scalar column is headed 'value'", () => {
    const columns = inferColumns([fieldMap(42)])
    expect(columns[0]).toMatchObject({ path: "", header: "value" })
  })
})

describe("fitColumns", () => {
  const cols = [
    { path: "a", header: "a", width: 10 },
    { path: "b", header: "b", width: 10 },
    { path: "c", header: "c", width: 10 },
  ]

  test("greedy prefix within budget", () => {
    expect(fitColumns(cols, 22, 2).map((c) => c.path)).toEqual(["a", "b"])
  })

  test("always keeps at least one column", () => {
    expect(fitColumns(cols, 3, 2).map((c) => c.path)).toEqual(["a"])
  })
})
