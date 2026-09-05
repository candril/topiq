import { describe, expect, test } from "bun:test"
import { coerceToType, unknownFields } from "./coerce.ts"
import { parseType } from "./avroType.ts"
import { validate } from "./encode.ts"
import { parseJsonLossless } from "./jsonFallback.ts"

// Spec 014's round trip in miniature: what JSON.parse hands back, put through the schema
// walk, has to equal what avsc decoded in the first place.

const RECORD = parseType(
  JSON.stringify({
    type: "record",
    name: "Order",
    fields: [
      { name: "CustomerId", type: "long" },
      { name: "Quantity", type: "int" },
      { name: "Price", type: "double" },
      { name: "Blob", type: "bytes" },
      { name: "Tags", type: { type: "array", items: "long" } },
      { name: "Meta", type: { type: "map", values: "long" } },
      { name: "Note", type: ["null", "string"] },
      { name: "Either", type: ["null", "long", "string"] },
    ],
  }),
)

const BIG = 9007199254740993n

describe("coerceToType — longs", () => {
  test("a bare integer literal at a long field becomes BigInt", () => {
    const out = coerceToType(parseType('"long"'), 4) as bigint
    expect(typeof out).toBe("bigint")
    expect(out).toBe(4n)
  })

  test("an int field keeps its Number — the walk is by position, not by looks", () => {
    expect(coerceToType(parseType('"int"'), 4)).toBe(4)
  })

  test("a BigInt already in hand is left alone (idempotent on decoded values)", () => {
    expect(coerceToType(parseType('"long"'), BIG)).toBe(BIG)
  })

  test("a non-integer at a long field is passed through, to be reported with its path", () => {
    expect(coerceToType(parseType('"long"'), 1.5)).toBe(1.5)
    expect(validate(parseType('"long"'), 1.5)).toHaveLength(1)
  })

  test('object-form {"type":"long"} coerces too — the avsc trap is normalised upstream', () => {
    expect(coerceToType(parseType(JSON.stringify({ type: "long" })), 7)).toBe(7n)
  })
})

describe("coerceToType — bytes", () => {
  test("a full-hex string becomes the same bytes", () => {
    const out = coerceToType(parseType('"bytes"'), "0xff00fe") as Buffer
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out.equals(Buffer.from([0xff, 0x00, 0xfe]))).toBe(true)
  })

  test("0x is empty bytes, not a failure", () => {
    expect((coerceToType(parseType('"bytes"'), "0x") as Buffer).length).toBe(0)
  })

  test("an odd digit count stays a string, so validate reports it", () => {
    expect(coerceToType(parseType('"bytes"'), "0xfff")).toBe("0xfff")
  })

  test("fixed is coerced the same way", () => {
    const fixed = parseType(JSON.stringify({ type: "fixed", name: "Hash", size: 2 }))
    expect((coerceToType(fixed, "0xdead") as Buffer).equals(Buffer.from([0xde, 0xad]))).toBe(true)
  })

  test("a string field that happens to look like hex is untouched", () => {
    expect(coerceToType(parseType('"string"'), "0xdead")).toBe("0xdead")
  })
})

describe("coerceToType — containers", () => {
  const decoded = {
    CustomerId: BIG,
    Quantity: 3,
    Price: 1.5,
    Blob: Buffer.from([0x01, 0x02]),
    Tags: [1n, 2n],
    Meta: { a: 5n },
    Note: "hi",
    Either: 9n,
  }

  test("a JSON round trip of a decoded record comes back identical", () => {
    // The buffer as the editor leaves it, read back the way the flow reads it: the
    // BigInt-aware parse first, then the schema walk.
    const buffer = `{
      "CustomerId": ${BIG},
      "Quantity": 3,
      "Price": 1.5,
      "Blob": "0x0102",
      "Tags": [1, 2],
      "Meta": { "a": 5 },
      "Note": "hi",
      "Either": 9
    }`
    const out = coerceToType(RECORD, parseJsonLossless(buffer)) as typeof decoded
    expect(out.CustomerId).toBe(BIG)
    expect(validate(RECORD, out)).toEqual([])
    expect(out.Tags.every((t) => typeof t === "bigint")).toBe(true)
    expect(out.Meta.a).toBe(5n)
    expect((out.Blob as Buffer).equals(Buffer.from([0x01, 0x02]))).toBe(true)
    expect(out.Quantity).toBe(3)
  })

  test("the decoded value coerces to itself — no round trip changes it", () => {
    expect(validate(RECORD, coerceToType(RECORD, decoded))).toEqual([])
  })
})

describe("coerceToType — unions", () => {
  const nullable = parseType(JSON.stringify(["null", "long"]))
  // avsc wraps a union only when its branches are ambiguous; two records always are, so this
  // is the shape that reaches the buffer as { "<branchName>": … }.
  const wrapped = parseType(
    JSON.stringify([
      { type: "record", name: "WithId", fields: [{ name: "id", type: "long" }] },
      { type: "record", name: "WithName", fields: [{ name: "name", type: "string" }] },
    ]),
  )

  test("an unwrapped nullable long takes the non-null branch", () => {
    expect(coerceToType(nullable, 7)).toBe(7n)
    expect(coerceToType(nullable, null)).toBeNull()
  })

  test("a wrapped union coerces inside the named branch only", () => {
    expect(wrapped.typeName).toBe("union:wrapped")
    expect(coerceToType(wrapped, { WithId: { id: 7 } })).toEqual({ WithId: { id: 7n } })
    expect(coerceToType(wrapped, { WithName: { name: "x" } })).toEqual({
      WithName: { name: "x" },
    })
  })

  test("an unrecognised branch name is left alone for validate to report", () => {
    expect(coerceToType(wrapped, { nope: 7 })).toEqual({ nope: 7 })
    expect(validate(wrapped, coerceToType(wrapped, { nope: 7 }))).not.toEqual([])
  })

  test("an unknown field inside a nullable record is still reported", () => {
    const optional = parseType(
      JSON.stringify([
        "null",
        { type: "record", name: "Inner", fields: [{ name: "a", type: "int" }] },
      ]),
    )
    expect(unknownFields(optional, { a: 1, b: 2 }).map((v) => v.path)).toEqual(["b"])
  })
})

describe("unknownFields", () => {
  test("a mistyped field name is reported with its path, not silently dropped", () => {
    const violations = unknownFields(RECORD, { CustomerId: 1n, Custmer: 2 })
    expect(violations.map((v) => v.path)).toEqual(["Custmer"])
    expect(violations[0]!.message).toContain("Order")
  })

  test("nested records report the dotted path", () => {
    const nested = parseType(
      JSON.stringify({
        type: "record",
        name: "Outer",
        fields: [
          {
            name: "inner",
            type: { type: "record", name: "Inner", fields: [{ name: "a", type: "int" }] },
          },
        ],
      }),
    )
    expect(unknownFields(nested, { inner: { a: 1, b: 2 } }).map((v) => v.path)).toEqual(["inner.b"])
  })

  test("array elements carry their index", () => {
    const list = parseType(
      JSON.stringify({
        type: "array",
        items: { type: "record", name: "Item", fields: [{ name: "a", type: "int" }] },
      }),
    )
    expect(unknownFields(list, [{ a: 1 }, { a: 1, z: 2 }]).map((v) => v.path)).toEqual(["1.z"])
  })

  test("a map's own keys are data, not fields — never reported", () => {
    const map = parseType(JSON.stringify({ type: "map", values: "int" }))
    expect(unknownFields(map, { anything: 1 })).toEqual([])
  })

  test("a correct record reports nothing", () => {
    expect(unknownFields(RECORD, { CustomerId: 1n, Note: null })).toEqual([])
  })
})
