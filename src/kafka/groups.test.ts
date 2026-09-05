import { describe, expect, test } from "bun:test"
import type { ConsumerGroupMeta, GroupOverview, PartitionOffset } from "@/types.ts"
import {
  consumesTopic,
  formatLag,
  formatTotalLag,
  isEphemeralGroup,
  toGroupRow,
  totalLag,
  visibleGroupRows,
  type GroupRow,
} from "./groups.ts"

function offset(partition: number, committed: bigint | null, high: bigint): PartitionOffset {
  return { partition, committed, high, lag: committed === null ? null : high - committed }
}

function meta(overrides: Partial<ConsumerGroupMeta> = {}): ConsumerGroupMeta {
  return {
    groupId: "g",
    state: "Stable",
    memberCount: 1,
    offsets: [],
    members: [],
    ...overrides,
  }
}

function overview(groupId: string, state = "Stable", memberCount = 1): GroupOverview {
  return { groupId, state, memberCount }
}

describe("totalLag", () => {
  test("sums committed partitions in bigint", () => {
    const t = totalLag([offset(0, 10n, 40n), offset(1, 5n, 6n)])
    expect(t.total).toBe(31n)
    expect(t.unknown).toBe(0)
  })

  test("stays past Number.MAX_SAFE_INTEGER", () => {
    const high = 9_007_199_254_740_993n
    expect(totalLag([offset(0, 0n, high)]).total).toBe(high)
  })

  test("an uncommitted partition is counted, never summed as zero", () => {
    const t = totalLag([offset(0, 10n, 40n), offset(1, null, 100n)])
    expect(t.total).toBe(30n)
    expect(t.unknown).toBe(1)
  })

  test("a group that committed nothing has no total at all", () => {
    const t = totalLag([offset(0, null, 40n), offset(1, null, 9n)])
    expect(t.total).toBeNull()
    expect(t.unknown).toBe(2)
  })

  test("no partitions is no total", () => {
    expect(totalLag([]).total).toBeNull()
  })
})

describe("formatting", () => {
  test("undefined lag renders as an em dash, not zero", () => {
    expect(formatLag(null)).toBe("—")
    expect(formatLag(0n)).toBe("0")
  })

  test("digits are grouped", () => {
    expect(formatLag(1234567n)).toBe("1,234,567")
  })

  test("a partial total is marked as a floor", () => {
    expect(formatTotalLag({ total: 30n, unknown: 1 })).toBe("30+?")
    expect(formatTotalLag({ total: 30n, unknown: 0 })).toBe("30")
    expect(formatTotalLag({ total: null, unknown: 3 })).toBe("—")
  })
})

describe("consumesTopic", () => {
  test("a committed offset counts", () => {
    expect(consumesTopic(meta({ offsets: [offset(0, 1n, 2n)] }))).toBe(true)
  })

  test("an assigned member counts", () => {
    expect(
      consumesTopic(
        meta({
          offsets: [offset(0, null, 2n)],
          members: [{ memberId: "m", clientId: "c", clientHost: "h", partitions: [0] }],
        }),
      ),
    ).toBe(true)
  })

  test("membership without an assignment on this topic does not", () => {
    expect(
      consumesTopic(
        meta({
          offsets: [offset(0, null, 2n)],
          members: [{ memberId: "m", clientId: "c", clientHost: "h", partitions: [] }],
        }),
      ),
    ).toBe(false)
  })
})

describe("isEphemeralGroup", () => {
  test("topiq's own reader groups are recognised", () => {
    expect(isEphemeralGroup("topiq-read-ab12cd34")).toBe(true)
    expect(isEphemeralGroup("orders-consumer")).toBe(false)
  })
})

describe("toGroupRow", () => {
  test("without a detail the lag is unknown, not zero", () => {
    const row = toGroupRow(overview("g"), null)
    expect(row.lag).toBeNull()
    expect(row.detail).toBeNull()
  })

  test("the detail's state wins over the listing's, which was read earlier", () => {
    const row = toGroupRow(
      overview("g", "PreparingRebalance", 0),
      meta({ groupId: "g", state: "Stable", memberCount: 2, offsets: [offset(0, 1n, 4n)] }),
    )
    expect(row.state).toBe("Stable")
    expect(row.memberCount).toBe(2)
    expect(row.lag?.total).toBe(3n)
  })
})

describe("visibleGroupRows", () => {
  const base = { filter: "", showEphemeral: false, onlyTopic: false, sort: "name" as const }
  const rows: GroupRow[] = [
    toGroupRow(overview("beta"), meta({ groupId: "beta", offsets: [offset(0, 1n, 100n)] })),
    toGroupRow(overview("alpha"), meta({ groupId: "alpha", offsets: [offset(0, 90n, 100n)] })),
    toGroupRow(overview("topiq-read-xyz"), meta({ groupId: "topiq-read-xyz" })),
    toGroupRow(overview("gamma"), null),
  ]

  test("topiq's reader groups are hidden by default and revealed on demand", () => {
    expect(visibleGroupRows(rows, base).map((r) => r.groupId)).toEqual(["alpha", "beta", "gamma"])
    expect(
      visibleGroupRows(rows, { ...base, showEphemeral: true }).map((r) => r.groupId),
    ).toContain("topiq-read-xyz")
  })

  test("the topic filter keeps rows whose detail has not landed", () => {
    const ids = visibleGroupRows(rows, { ...base, onlyTopic: true }).map((r) => r.groupId)
    expect(ids).toEqual(["alpha", "beta", "gamma"])
  })

  test("the topic filter drops a described group that consumes nothing here", () => {
    const idle = toGroupRow(
      overview("idle"),
      meta({ groupId: "idle", offsets: [offset(0, null, 9n)] }),
    )
    const ids = visibleGroupRows([...rows, idle], { ...base, onlyTopic: true }).map(
      (r) => r.groupId,
    )
    expect(ids).not.toContain("idle")
  })

  test("substring filter over the group id", () => {
    expect(visibleGroupRows(rows, { ...base, filter: "ET" }).map((r) => r.groupId)).toEqual([
      "beta",
    ])
  })

  test("lag sort is descending, and unmeasured lag sorts last", () => {
    expect(visibleGroupRows(rows, { ...base, sort: "lag" }).map((r) => r.groupId)).toEqual([
      "beta",
      "alpha",
      "gamma",
    ])
  })
})
