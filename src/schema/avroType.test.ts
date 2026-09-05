import { describe, expect, test } from "bun:test"
import { parseType } from "./avroType.ts"

// The one place avsc types are built, and the one place invariant 1 can be lost: a `long`
// that resolves to avsc's own LongType decodes to Number and rejects a BigInt, so every
// long in a schema has to reach the registry override, however it was written (nfr/006).

const BIG = 9007199254740993n

function typeOf(schema: unknown) {
  return parseType(JSON.stringify(schema))
}

describe("parseType — long normalisation", () => {
  test("the name form resolves through the registry", () => {
    expect(typeOf("long").typeName).toBe("abstract:long")
  })

  test("the object form does too, top level", () => {
    expect(typeOf({ type: "long" }).typeName).toBe("abstract:long")
  })

  test("a logical annotation does not smuggle in avsc's Number long", () => {
    const type = typeOf({
      type: "record",
      name: "Event",
      fields: [{ name: "ts", type: { type: "long", logicalType: "timestamp-millis" } }],
    })
    const value = { ts: BIG }
    // Round trip rather than a typeName assertion: what matters is that a value past 2^53
    // survives, where avsc's native long throws "potential precision loss".
    expect((type.fromBuffer(type.toBuffer(value)) as { ts: bigint }).ts).toBe(BIG)
  })

  test("longs inside arrays, maps and unions resolve the same way", () => {
    const type = typeOf({
      type: "record",
      name: "Bag",
      fields: [
        { name: "list", type: { type: "array", items: { type: "long" } } },
        { name: "byName", type: { type: "map", values: { type: "long" } } },
        { name: "maybe", type: ["null", { type: "long", logicalType: "timestamp-millis" }] },
      ],
    })
    const value = { list: [BIG], byName: { a: BIG }, maybe: BIG }
    expect(type.fromBuffer(type.toBuffer(value))).toEqual(value)
  })

  test("a long field with a declared default is parseable at all", () => {
    // avsc copies a declared default through the long type's own JSON round trip, so a
    // throwing toJSON made every such schema — and therefore the whole topic — undecodable.
    const type = typeOf({
      type: "record",
      name: "WithDefault",
      fields: [{ name: "retries", type: "long", default: 3 }],
    })
    expect(
      (type as unknown as { fields: { defaultValue: () => unknown }[] }).fields[0]!.defaultValue(),
    ).toBe(3n)
  })

  test("a named type reference still resolves", () => {
    const type = typeOf({
      type: "record",
      name: "Node",
      fields: [
        { name: "id", type: { type: "long" } },
        { name: "next", type: ["null", "Node"] },
      ],
    })
    const value = { id: BIG, next: { id: 1n, next: null } }
    expect(type.fromBuffer(type.toBuffer(value))).toEqual(value)
  })

  test("enums and fixed keep their declarations", () => {
    const type = typeOf({
      type: "record",
      name: "R",
      fields: [
        { name: "state", type: { type: "enum", name: "S", symbols: ["A", "B"] } },
        { name: "hash", type: { type: "fixed", name: "F", size: 4 } },
      ],
    })
    const value = { state: "B", hash: Buffer.alloc(4, 7) }
    expect(type.fromBuffer(type.toBuffer(value))).toEqual(value)
  })
})
