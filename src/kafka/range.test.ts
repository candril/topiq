import { describe, expect, test } from "bun:test"
import { messageCount, resolveStarts } from "./range.ts"

// Watermarks above 2^53: Number arithmetic would silently round (nfr/006).
const HUGE = 9007199254740993n

describe("resolveStarts", () => {
  const partitions = [
    { id: 0, low: 0n, high: 100n },
    { id: 1, low: 50n, high: 60n },
    { id: 2, low: 0n, high: HUGE },
  ]

  test("latestN over-fetches per partition, clamped to low", () => {
    const starts = resolveStarts({ kind: "latestN", n: 30 }, partitions)
    expect(starts).toEqual([
      { partition: 0, offset: 90n },
      { partition: 1, offset: 50n }, // 60-10 < low 50 -> clamped
      { partition: 2, offset: HUGE - 10n }, // exact bigint math above 2^53
    ])
  })

  test("offset is clamped into each partition's watermark window", () => {
    const starts = resolveStarts({ kind: "offset", offset: 55n }, partitions)
    expect(starts).toEqual([
      { partition: 0, offset: 55n },
      { partition: 1, offset: 55n },
      { partition: 2, offset: 55n },
    ])
    expect(resolveStarts({ kind: "offset", offset: 0n }, [partitions[1]!])[0]!.offset).toBe(50n)
  })

  test("beginning starts at low", () => {
    expect(resolveStarts({ kind: "beginning" }, [partitions[1]!])[0]!.offset).toBe(50n)
  })

  test("end is the high watermark, exact above 2^53 (spec 018)", () => {
    expect(resolveStarts({ kind: "end" }, partitions).map((s) => s.offset)).toEqual([
      100n,
      60n,
      HUGE,
    ])
  })

  test("timestamp ranges must be broker-resolved first", () => {
    expect(() => resolveStarts({ kind: "timestamp", timestamp: new Date() }, partitions)).toThrow()
  })
})

describe("messageCount", () => {
  test("sums high-low in bigint", () => {
    expect(messageCount([{ id: 0, low: 5n, high: HUGE }])).toBe(HUGE - 5n)
  })
})
