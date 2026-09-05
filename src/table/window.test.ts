import { describe, expect, test } from "bun:test"
import type { DecodedMessage } from "@/types.ts"
import {
  formatTimestamp,
  parseRangeInput,
  plannedCount,
  rangeSummary,
  resolvedSummary,
  sortWindow,
  trimLatestN,
  WINDOW_CAP,
} from "./window.ts"

function msg(partition: number, offset: bigint, ts: number): DecodedMessage {
  return {
    topic: "t",
    partition,
    offset,
    timestamp: new Date(ts),
    key: null,
    value: null,
    headers: {},
    decodedKey: null,
    decodedValue: null,
  }
}

describe("sortWindow", () => {
  test("newest first: timestamp desc, then partition, then offset desc", () => {
    const rows = [msg(1, 5n, 200), msg(0, 9n, 100), msg(0, 1n, 200), msg(0, 2n, 200)]
    expect(sortWindow(rows).map((m) => [m.partition, m.offset])).toEqual([
      [0, 2n],
      [0, 1n],
      [1, 5n],
      [0, 9n],
    ])
  })

  test("row 0 is the newest row", () => {
    const rows = [msg(0, 1n, 100), msg(0, 3n, 300), msg(0, 2n, 200)]
    expect(sortWindow(rows)[0]?.offset).toBe(3n)
  })
})

describe("trimLatestN", () => {
  test("keeps the newest n, which is the head of a descending window", () => {
    const sorted = sortWindow([msg(0, 1n, 100), msg(0, 2n, 200), msg(0, 3n, 300)])
    expect(trimLatestN(sorted, 2).map((m) => m.offset)).toEqual([3n, 2n])
    expect(trimLatestN(sorted, 5)).toHaveLength(3)
  })
})

describe("formatTimestamp", () => {
  test("UTC with millis", () => {
    expect(formatTimestamp(new Date(Date.UTC(2026, 7, 27, 18, 23, 45, 123)))).toBe(
      "2026-08-27 18:23:45.123",
    )
  })
})

describe("rangeSummary", () => {
  test("offset keeps full bigint digits", () => {
    expect(rangeSummary({ kind: "offset", offset: 9007199254740993n })).toBe(
      "offset ≥ 9007199254740993",
    )
  })
  test("latestN and beginning", () => {
    expect(rangeSummary({ kind: "latestN", n: 50 })).toBe("latest 50")
    expect(rangeSummary({ kind: "beginning" })).toBe("beginning")
  })
})

describe("plannedCount / resolvedSummary", () => {
  const partitions = [
    { id: 0, low: 0n, high: 100n },
    { id: 1, low: 0n, high: 40n },
  ]

  test("sums high − start, skipping null starts", () => {
    const starts = [
      { partition: 0, offset: 90n },
      { partition: 1, offset: null },
    ]
    expect(plannedCount(starts, partitions)).toBe(10n)
  })

  test("few partitions list explicit ranges", () => {
    const starts = [
      { partition: 0, offset: 90n },
      { partition: 1, offset: 35n },
    ]
    expect(resolvedSummary(starts, partitions)).toBe("p0 90‥100 · p1 35‥40")
  })

  test("all-null starts read as an empty window", () => {
    expect(resolvedSummary([{ partition: 0, offset: null }], partitions)).toBe("empty window")
  })
})

describe("parseRangeInput", () => {
  test("offset digits become bigint — no Number round trip", () => {
    expect(parseRangeInput("offset", "9007199254740993")).toEqual({
      range: { kind: "offset", offset: 9007199254740993n },
    })
    expect(parseRangeInput("offset", "12x")).toHaveProperty("error")
  })

  test("latestN is bounded by the window cap", () => {
    expect(parseRangeInput("latestN", "50")).toEqual({ range: { kind: "latestN", n: 50 } })
    expect(parseRangeInput("latestN", "0")).toHaveProperty("error")
    expect(parseRangeInput("latestN", String(WINDOW_CAP + 1))).toHaveProperty("error")
  })

  test("timestamp accepts ISO and epoch millis", () => {
    const iso = parseRangeInput("timestamp", "2026-08-27T10:00:00Z")
    expect(iso).toEqual({
      range: { kind: "timestamp", timestamp: new Date("2026-08-27T10:00:00Z") },
    })
    const epoch = parseRangeInput("timestamp", "1756288800000")
    expect(epoch).toEqual({ range: { kind: "timestamp", timestamp: new Date(1756288800000) } })
    expect(parseRangeInput("timestamp", "yesterday")).toHaveProperty("error")
  })
})
