import { describe, expect, test } from "bun:test"
import type { DecodedMessage } from "@/types.ts"
import { fuzzyScore, splitLastTerm, suggest } from "./suggest.ts"

function row(value: unknown, overrides: Partial<DecodedMessage> = {}): DecodedMessage {
  return {
    topic: "t",
    partition: 1,
    offset: 5n,
    timestamp: new Date("2026-08-27T10:00:00Z"),
    key: Buffer.from("k"),
    value: Buffer.from("v"),
    headers: {},
    decodedKey: 717197126n,
    decodedValue: value,
    ...overrides,
  } as DecodedMessage
}

const labels = (s: { label: string }[]) => s.map((x) => x.label)
const terms = (s: { term: string }[]) => s.map((x) => x.term)

describe("splitLastTerm", () => {
  test("only the term under the cursor is completed", () => {
    expect(splitLastTerm("value.Id:1 val")).toEqual({ prefix: "value.Id:1 ", term: "val" })
    expect(splitLastTerm("val")).toEqual({ prefix: "", term: "val" })
    expect(splitLastTerm("value.Id:1 ")).toEqual({ prefix: "value.Id:1 ", term: "" })
  })
})

describe("fuzzyScore", () => {
  test("subsequence matches, non-matches score zero", () => {
    expect(fuzzyScore("cu", "CustomerId")).toBeGreaterThan(0)
    expect(fuzzyScore("zz", "CustomerId")).toBe(0)
  })

  test("a prefix hit outranks a mid-string hit", () => {
    expect(fuzzyScore("cu", "CustomerId")).toBeGreaterThan(fuzzyScore("cu", "AccountCurrency"))
  })
})

describe("suggest — field position (progressive, one segment at a time)", () => {
  const columns = ["CustomerId", "Entity.Name", "Entity.Id"]

  test("an empty bar offers the envelope roots, not every leaf path", () => {
    const s = suggest({ query: "", columns, rows: [] })
    expect(labels(s)).toEqual(["key", "value", "headers", "partition", "offset", "timestamp"])
  })

  test("a root with children completes to `root.` so the next accept drills in", () => {
    const s = suggest({ query: "val", columns, rows: [] })
    expect(labels(s)).toEqual(["value"])
    expect(terms(s)).toEqual(["value."])
  })

  test("a scalar root completes straight to `root:`", () => {
    expect(terms(suggest({ query: "off", columns, rows: [] }))).toEqual(["offset:"])
  })

  test("accepting `value.` re-offers only what lives under it", () => {
    const s = suggest({ query: "value.", columns, rows: [] })
    expect(labels(s)).toEqual(["value.CustomerId", "value.Entity"])
    // A leaf is ready for a value; a namespace drills one more level.
    expect(terms(s)).toEqual(["value.CustomerId:", "value.Entity."])
  })

  test("nested namespaces drill further", () => {
    const s = suggest({ query: "value.Entity.", columns, rows: [] })
    expect(labels(s)).toEqual(["value.Entity.Name", "value.Entity.Id"])
    expect(terms(s)).toEqual(["value.Entity.Name:", "value.Entity.Id:"])
  })

  test("a partial segment narrows within the level", () => {
    expect(labels(suggest({ query: "value.Ent", columns, rows: [] }))).toEqual(["value.Entity"])
  })

  test("negation is preserved at every level", () => {
    expect(terms(suggest({ query: "-val", columns, rows: [] }))).toEqual(["-value."])
    expect(terms(suggest({ query: "-value.Cust", columns, rows: [] }))).toEqual([
      "-value.CustomerId:",
    ])
  })

  test("only the last term is completed", () => {
    expect(labels(suggest({ query: "value.CustomerId:1 off", columns, rows: [] }))).toEqual([
      "offset",
    ])
  })
})

describe("suggest — value position", () => {
  const rows = [
    row({ Status: "active", Id: 9007199254740993n }),
    row({ Status: "closed", Id: 2n }),
    row({ Status: "active", Id: 3n }),
  ]

  test("distinct values from the loaded rows, as complete terms", () => {
    const s = suggest({ query: "value.Status:", columns: ["Status"], rows })
    expect(labels(s)).toEqual(["active", "closed"])
    expect(terms(s)).toEqual(["value.Status:active", "value.Status:closed"])
  })

  test("a partial value narrows the samples", () => {
    const s = suggest({ query: "value.Status:clo", columns: ["Status"], rows })
    expect(labels(s)).toEqual(["closed"])
  })

  test("BigInt values are offered as full digits, never rounded", () => {
    const s = suggest({ query: "value.Id:", columns: ["Id"], rows })
    expect(labels(s)).toContain("9007199254740993")
  })

  test("ordering operators sample values too", () => {
    const s = suggest({ query: "value.Id>", columns: ["Id"], rows })
    expect(terms(s)).toContain("value.Id>2")
  })

  test("envelope fields sample from the message, not the payload", () => {
    expect(labels(suggest({ query: "partition:", columns: [], rows }))).toEqual(["1"])
    expect(labels(suggest({ query: "key:", columns: [], rows }))).toEqual(["717197126"])
  })

  test("undecodable rows contribute nothing rather than throwing", () => {
    const broken = [row(null, { decodeError: "boom" })]
    expect(suggest({ query: "value.Status:", columns: ["Status"], rows: broken })).toEqual([])
  })
})
