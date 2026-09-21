import { describe, expect, test } from "bun:test"
import { applyLogicalDates } from "./logical.ts"

const MS = 1_789_980_152_905n
const WHEN = "2026-09-21T08:42:32.905Z"

const timestamp = { type: "long", logicalType: "timestamp-millis" }

function record(fields: { name: string; type: unknown }[]): unknown {
  return { type: "record", name: "Event", fields }
}

describe("applyLogicalDates (spec 031)", () => {
  test("a declared timestamp becomes a Date", () => {
    const out = applyLogicalDates(record([{ name: "placedAt", type: timestamp }]), {
      placedAt: MS,
    }) as { placedAt: Date }
    expect(out.placedAt).toBeInstanceOf(Date)
    expect(out.placedAt.toISOString()).toBe(WHEN)
  })

  test("a plain long is left as a BigInt — the reading comes from the schema, never the value", () => {
    const out = applyLogicalDates(record([{ name: "orderId", type: "long" }]), {
      orderId: MS,
    }) as { orderId: bigint }
    expect(out.orderId).toBe(MS)
  })

  test("`date` counts days from the epoch at UTC midnight", () => {
    const out = applyLogicalDates(
      record([{ name: "day", type: { type: "int", logicalType: "date" } }]),
      { day: 20_717 },
    ) as { day: Date }
    expect(out.day.toISOString()).toBe("2026-09-21T00:00:00.000Z")
  })

  test("nested records, arrays and maps are all reached", () => {
    const schema = record([
      {
        name: "meta",
        type: { type: "record", name: "Meta", fields: [{ name: "at", type: timestamp }] },
      },
      {
        name: "legs",
        type: {
          type: "array",
          items: { type: "record", name: "Leg", fields: [{ name: "at", type: timestamp }] },
        },
      },
      { name: "marks", type: { type: "map", values: timestamp } },
    ])
    const out = applyLogicalDates(schema, {
      meta: { at: MS },
      legs: [{ at: MS }, { at: MS }],
      marks: { first: MS },
    }) as { meta: { at: Date }; legs: { at: Date }[]; marks: Record<string, Date> }

    expect(out.meta.at.toISOString()).toBe(WHEN)
    expect(out.legs.map((l) => l.at.toISOString())).toEqual([WHEN, WHEN])
    expect(out.marks.first!.toISOString()).toBe(WHEN)
  })

  test("an optional timestamp converts, and its null stays null", () => {
    const schema = record([{ name: "closedAt", type: ["null", timestamp] }])
    expect(
      (applyLogicalDates(schema, { closedAt: MS }) as { closedAt: Date }).closedAt,
    ).toBeInstanceOf(Date)
    expect(
      (applyLogicalDates(schema, { closedAt: null }) as { closedAt: null }).closedAt,
    ).toBeNull()
  })

  test("a named record referenced a second time is still walked", () => {
    const schema = record([
      {
        name: "opened",
        type: { type: "record", name: "Stamp", fields: [{ name: "at", type: timestamp }] },
      },
      { name: "closed", type: "Stamp" },
    ])
    const out = applyLogicalDates(schema, { opened: { at: MS }, closed: { at: MS } }) as {
      opened: { at: Date }
      closed: { at: Date }
    }
    expect(out.opened.at).toBeInstanceOf(Date)
    expect(out.closed.at).toBeInstanceOf(Date)
  })

  test("a self-referential schema terminates on finite data", () => {
    const schema = {
      type: "record",
      name: "Node",
      fields: [
        { name: "at", type: timestamp },
        { name: "next", type: ["null", "Node"] },
      ],
    }
    const out = applyLogicalDates(schema, { at: MS, next: { at: MS, next: null } }) as {
      at: Date
      next: { at: Date }
    }
    expect(out.at).toBeInstanceOf(Date)
    expect(out.next.at).toBeInstanceOf(Date)
  })

  test("the logical types that do not map cleanly keep their digits (spec 031 Decisions)", () => {
    for (const logicalType of [
      "timestamp-micros",
      "time-millis",
      "time-micros",
      "local-timestamp-millis",
    ]) {
      const out = applyLogicalDates(record([{ name: "at", type: { type: "long", logicalType } }]), {
        at: MS,
      }) as { at: unknown }
      expect(out.at).toBe(MS)
    }
  })

  test("a value with nothing to convert comes back by identity, not copied", () => {
    const schema = record([{ name: "orderId", type: "long" }])
    const value = { orderId: MS }
    expect(applyLogicalDates(schema, value)).toBe(value)
  })

  test("a schema that does not describe the value leaves it alone", () => {
    const value = { anything: 1 }
    expect(applyLogicalDates("string", value)).toBe(value)
    expect(applyLogicalDates(undefined, value)).toBe(value)
  })
})
