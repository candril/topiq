import { describe, expect, test } from "bun:test"
import { parseType } from "./avroType.ts"
import { validate } from "./encode.ts"
import { skeletonFor, unionNotes } from "./skeleton.ts"

// Spec 015: the placeholder a crafted message starts from. The invariant every case below
// serves is the same one — a skeleton is a *decoded* value, so it must validate against its
// own type and carry a BigInt everywhere the schema says long (nfr/006 invariant 1).

function typeOf(schema: unknown) {
  return parseType(JSON.stringify(schema))
}

function skeleton(schema: unknown): unknown {
  return skeletonFor(typeOf(schema))
}

describe("skeletonFor — primitives", () => {
  test("a long placeholder is a BigInt, not a Number", () => {
    expect(skeleton("long")).toBe(0n)
    expect(typeof skeleton("long")).toBe("bigint")
  })

  test("an int placeholder stays a Number — promoting it would fail validation", () => {
    expect(skeleton("int")).toBe(0)
    expect(typeof skeleton("int")).toBe("number")
  })

  test("string, boolean and double get their empty forms", () => {
    expect(skeleton("string")).toBe("")
    expect(skeleton("boolean")).toBe(false)
    expect(skeleton("double")).toBe(0)
  })

  test("bytes is an empty buffer, which renders as the editable 0x form", () => {
    expect(Buffer.isBuffer(skeleton("bytes"))).toBe(true)
    expect((skeleton("bytes") as Buffer).length).toBe(0)
  })

  test("fixed is exactly its declared size — a shorter buffer would not encode", () => {
    const value = skeleton({ type: "fixed", name: "Md5", size: 16 }) as Buffer
    expect(value.length).toBe(16)
  })

  test("an enum takes its first symbol", () => {
    expect(skeleton({ type: "enum", name: "State", symbols: ["NEW", "SHIPPED"] })).toBe("NEW")
  })
})

describe("skeletonFor — records", () => {
  const ORDER = {
    type: "record",
    name: "Order",
    fields: [
      { name: "Id", type: "long" },
      { name: "Note", type: ["null", "string"] },
      {
        name: "Lines",
        type: {
          type: "array",
          items: {
            type: "record",
            name: "Line",
            fields: [
              { name: "Sku", type: "string" },
              { name: "Qty", type: "int" },
            ],
          },
        },
      },
      { name: "Tags", type: { type: "map", values: "string" } },
    ],
  }

  test("every field is present and the whole thing validates against its own type", () => {
    const type = typeOf(ORDER)
    const value = skeletonFor(type)
    expect(validate(type, value)).toEqual([])
  })

  test("a nested long is a BigInt too", () => {
    const nested = skeleton({
      type: "record",
      name: "Outer",
      fields: [
        {
          name: "inner",
          type: { type: "record", name: "Inner", fields: [{ name: "n", type: "long" }] },
        },
      ],
    }) as { inner: { n: unknown } }
    expect(nested.inner.n).toBe(0n)
  })

  test("a declared default wins over an invented placeholder", () => {
    const value = skeleton({
      type: "record",
      name: "WithDefaults",
      fields: [
        { name: "channel", type: "string", default: "web" },
        { name: "retries", type: "long", default: 3 },
      ],
    }) as { channel: unknown; retries: unknown }
    expect(value.channel).toBe("web")
    // avsc hands the default back decoded, so the BigInt long stays a BigInt.
    expect(value.retries).toBe(3n)
  })

  test("arrays and maps carry one sample so their shape is visible", () => {
    const value = skeleton(ORDER) as { Lines: unknown[]; Tags: Record<string, unknown> }
    expect(value.Lines).toHaveLength(1)
    expect(value.Lines[0]).toEqual({ Sku: "", Qty: 0 })
    expect(Object.keys(value.Tags)).toEqual(["key"])
  })
})

describe("skeletonFor — unions", () => {
  test("the first non-null branch is filled in, so the payload shape is visible", () => {
    const value = skeleton({
      type: "record",
      name: "Envelope",
      fields: [
        {
          name: "body",
          type: ["null", { type: "record", name: "Body", fields: [{ name: "id", type: "long" }] }],
        },
      ],
    }) as { body: { id: unknown } }
    expect(value.body.id).toBe(0n)
  })

  test("a wrapped union names its branch, which is the form the reader expects", () => {
    // wrapUnions is avsc's decision, so this drives it through a type built the same way
    // the registry path builds one and asserts on whichever form came out.
    const type = typeOf({
      type: "record",
      name: "R",
      fields: [{ name: "u", type: ["null", "string", "int"] }],
    })
    const value = skeletonFor(type)
    expect(validate(type, value)).toEqual([])
  })

  test("a recursive record falls back to null rather than looping forever", () => {
    const type = typeOf({
      type: "record",
      name: "Node",
      fields: [
        { name: "label", type: "string" },
        { name: "next", type: ["null", "Node"] },
        { name: "kids", type: { type: "array", items: "Node" } },
      ],
    })
    const value = skeletonFor(type) as { next: unknown; kids: unknown[] }
    expect(value.next).toBeNull()
    // The item would be another Node, so the sample is dropped rather than nested forever.
    expect(value.kids).toEqual([])
    expect(validate(type, value)).toEqual([])
  })
})

describe("unionNotes", () => {
  test("every union position is named with its branches, by path", () => {
    const notes = unionNotes(
      typeOf({
        type: "record",
        name: "Order",
        fields: [
          { name: "Note", type: ["null", "string"] },
          {
            name: "Lines",
            type: {
              type: "array",
              items: {
                type: "record",
                name: "Line",
                fields: [{ name: "Discount", type: ["null", "double"] }],
              },
            },
          },
        ],
      }),
    )
    expect(notes).toEqual([
      { path: "Note", branches: ["null", "string"] },
      { path: "Lines[].Discount", branches: ["null", "double"] },
    ])
  })

  test("a schema without unions has nothing to say", () => {
    expect(
      unionNotes(typeOf({ type: "record", name: "R", fields: [{ name: "a", type: "int" }] })),
    ).toEqual([])
  })
})
