import { describe, expect, test } from "bun:test"
import { groupSeekRefusal } from "@/kafka/groups.ts"
import type { PartitionStart } from "@/kafka/range.ts"
import type { PartitionOffset } from "@/types.ts"
import {
  movedRows,
  seekAction,
  seekPreviewLines,
  seekRange,
  seekResult,
  seekRowLabel,
  seekRows,
  seekTargetLabel,
  type SeekRow,
} from "./model.ts"

function committed(partition: number, offset: bigint | null, high = 1000n): PartitionOffset {
  return { partition, committed: offset, high, lag: offset === null ? null : high - offset }
}

function start(partition: number, offset: bigint | null): PartitionStart {
  return { partition, offset }
}

describe("seekRange", () => {
  test("beginning and end need no value", () => {
    expect(seekRange("beginning", "")).toEqual({ range: { kind: "beginning" } })
    expect(seekRange("end", "")).toEqual({ range: { kind: "end" } })
  })

  test("an offset stays bigint past 2^53", () => {
    expect(seekRange("offset", "9007199254740993")).toEqual({
      range: { kind: "offset", offset: 9007199254740993n },
    })
  })

  test("a target that cannot be parsed is an error, not a guess", () => {
    expect(seekRange("offset", "-1")).toHaveProperty("error")
    expect(seekRange("timestamp", "yesterday")).toHaveProperty("error")
  })
})

describe("seekTargetLabel", () => {
  test("names what the dialog is about to commit", () => {
    expect(seekTargetLabel({ kind: "beginning" })).toBe("beginning")
    expect(seekTargetLabel({ kind: "end" })).toBe("end")
    expect(seekTargetLabel({ kind: "offset", offset: 4711n })).toBe("offset 4711")
    expect(
      seekTargetLabel({ kind: "timestamp", timestamp: new Date("2026-08-01T00:00:00Z") }),
    ).toBe("timestamp 2026-08-01T00:00:00.000Z")
  })
})

describe("seekRows", () => {
  test("pairs each partition's committed offset with where the target lands", () => {
    const rows = seekRows([committed(1, 500n), committed(0, 12n)], [start(0, 0n), start(1, 0n)])
    expect(rows).toEqual([
      { partition: 0, before: 12n, after: 0n },
      { partition: 1, before: 500n, after: 0n },
    ])
  })

  test("an uncommitted partition has no before — not a before of zero", () => {
    const [row] = seekRows([committed(0, null)], [start(0, 40n)])
    expect(row?.before).toBeNull()
    expect(seekRowLabel(row as SeekRow)).toBe("p0 — → 40")
  })

  test("a partition the target does not resolve to keeps its offset", () => {
    // A timestamp past the end of one partition: the broker has nothing at or after it, so
    // that partition is left alone rather than rewound to the log start.
    const rows = seekRows([committed(0, 90n), committed(1, 7n)], [start(0, 95n), start(1, null)])
    expect(rows[1]).toEqual({ partition: 1, before: 7n, after: null })
    expect(movedRows(rows)).toHaveLength(1)
  })

  test("a partition only the group knows about still shows up", () => {
    expect(seekRows([committed(9, 3n)], [])).toEqual([{ partition: 9, before: 3n, after: null }])
  })
})

describe("movedRows", () => {
  test("a target that resolves to where the group already is moves nothing", () => {
    const rows = seekRows([committed(0, 40n), committed(1, 40n)], [start(0, 40n), start(1, 40n)])
    expect(movedRows(rows)).toEqual([])
    // Which is what makes the gate refuse: count 0 means "nothing to seek".
    expect(seekAction("g", "t", { kind: "offset", offset: 40n }, rows).count).toBe(0)
  })
})

describe("seekPreviewLines", () => {
  test("states the untouched partitions instead of dropping them", () => {
    const rows = seekRows([committed(0, 5n), committed(1, 5n)], [start(0, 0n), start(1, 5n)])
    expect(seekPreviewLines(rows)).toEqual(["p0 5 → 0", "1 unchanged"])
  })

  test("a wide topic is summarised, never silently cut", () => {
    const rows = seekRows(
      Array.from({ length: 12 }, (_, i) => committed(i, 5n)),
      Array.from({ length: 12 }, (_, i) => start(i, 0n)),
    )
    const lines = seekPreviewLines(rows)
    expect(lines).toHaveLength(9)
    expect(lines.at(-1)).toBe("+4 more partitions")
  })
})

describe("seekAction", () => {
  test("carries group, topic, target and the partitions that move", () => {
    const rows = seekRows([committed(0, 5n), committed(1, 5n)], [start(0, 0n), start(1, 0n)])
    expect(seekAction("orders-projector", "dg-orders", { kind: "beginning" }, rows)).toEqual({
      kind: "seek",
      group: "orders-projector",
      topic: "dg-orders",
      count: 2,
      to: "beginning",
      moves: ["p0 5 → 0", "p1 5 → 0"],
    })
  })
})

describe("seekResult", () => {
  const planned = seekRows([committed(0, 5n), committed(1, 5n)], [start(0, 0n), start(1, 0n)])

  test("reports the offsets the broker actually holds", () => {
    const result = seekResult("g", "dg-orders", planned, [committed(0, 0n), committed(1, 0n)])
    expect(result.ok).toBe(true)
    expect(result.message).toBe("g on dg-orders now committed p0 @ 0, p1 @ 0")
  })

  test("a partial apply is a failure, and says which partition missed", () => {
    const result = seekResult("g", "dg-orders", planned, [committed(0, 0n), committed(1, 5n)])
    expect(result.ok).toBe(false)
    expect(result.message).toContain("1/2 partitions moved")
    expect(result.message).toContain("p1 asked 0, committed 5")
  })

  test("a partition missing from the read-back is not assumed to have moved", () => {
    const result = seekResult("g", "dg-orders", planned, [committed(0, 0n)])
    expect(result.ok).toBe(false)
    expect(result.message).toContain("p1 asked 0, committed —")
  })
})

describe("groupSeekRefusal", () => {
  test("an empty group is seekable", () => {
    expect(groupSeekRefusal("g", "Empty", 0)).toBeNull()
  })

  test("a live group is refused with its state, not with a broker error", () => {
    const reason = groupSeekRefusal("orders-projector", "Stable", 3)
    expect(reason).toContain("orders-projector is Stable with 3 members")
    expect(reason).toContain("Empty")
  })

  test("says the scale-down is the user's step", () => {
    expect(groupSeekRefusal("g", "PreparingRebalance", 1)).toContain("stays manual")
    expect(groupSeekRefusal("g", "PreparingRebalance", 1)).toContain("1 member —")
  })
})
