import { describe, expect, test } from "bun:test"
import type { PartitionMeta, TopicSummary } from "@/types.ts"
import {
  formatApprox,
  formatRowCount,
  isInternal,
  PANE_MAX_ROWS,
  partitionPaneRows,
  partitionRangeLabel,
  toRow,
  visibleRows,
  windowStart,
  type Measured,
} from "./topicListModel.ts"

function partitions(ranges: [bigint, bigint][]): PartitionMeta[] {
  return ranges.map(([low, high], id) => ({ id, low, high }))
}

const OFFSETS: Record<string, [bigint, bigint][]> = {
  "app.orders": [
    [0n, 10n],
    [5n, 10n],
  ],
  "app.users": [[0n, 100n]],
  "billing.invoices": [
    [0n, 1n],
    [0n, 1n],
    [0n, 1n],
  ],
  __consumer_offsets: [[0n, 50n]],
  _schemas: [[0n, 7n]],
}

const fleet: TopicSummary[] = Object.entries(OFFSETS).map(([name, ranges]) => ({
  name,
  partitionCount: ranges.length,
}))

/** Every topic measured — the state the list reaches once the window has been fetched. */
const allMeasured: Measured = new Map(
  Object.entries(OFFSETS).map(([name, ranges]) => [name, partitions(ranges)]),
)

const none: Measured = new Map()

const defaults = { filter: "", showInternal: false, sort: "name" as const }

describe("isInternal", () => {
  test("underscore prefix marks internal", () => {
    expect(isInternal("__consumer_offsets")).toBe(true)
    expect(isInternal("_schemas")).toBe(true)
    expect(isInternal("app.orders")).toBe(false)
  })
})

describe("toRow", () => {
  test("sums high − low across partitions as bigint", () => {
    const row = toRow(
      { name: "t", partitionCount: 2 },
      new Map([
        [
          "t",
          partitions([
            [0n, 2n ** 60n],
            [10n, 2n ** 60n],
          ]),
        ],
      ]),
    )
    expect(row.messages).toBe(2n ** 61n - 10n)
    expect(row.partitionCount).toBe(2)
  })

  test("an unmeasured topic has a null count, never zero", () => {
    const row = toRow({ name: "t", partitionCount: 4 }, none)
    expect(row.messages).toBeNull()
    expect(row.partitionCount).toBe(4)
  })
})

describe("visibleRows", () => {
  test("hides internal topics by default, shows them on toggle", () => {
    const names = visibleRows(fleet, allMeasured, defaults).map((r) => r.name)
    expect(names).toEqual(["app.orders", "app.users", "billing.invoices"])
    const withInternal = visibleRows(fleet, allMeasured, { ...defaults, showInternal: true }).map(
      (r) => r.name,
    )
    expect(withInternal).toContain("__consumer_offsets")
    expect(withInternal).toContain("_schemas")
  })

  test("filter narrows case-insensitively", () => {
    const names = visibleRows(fleet, allMeasured, { ...defaults, filter: "ORDER" }).map(
      (r) => r.name,
    )
    expect(names).toEqual(["app.orders"])
  })

  test("topic_prefix restricts the namespace but not the internal toggle", () => {
    const names = visibleRows(fleet, allMeasured, { ...defaults, topicPrefix: "app." }).map(
      (r) => r.name,
    )
    expect(names).toEqual(["app.orders", "app.users"])
    const withInternal = visibleRows(fleet, allMeasured, {
      ...defaults,
      topicPrefix: "app.",
      showInternal: true,
    }).map((r) => r.name)
    expect(withInternal).toEqual(["__consumer_offsets", "_schemas", "app.orders", "app.users"])
  })

  test("sort by messages is descending", () => {
    const names = visibleRows(fleet, allMeasured, { ...defaults, sort: "messages" }).map(
      (r) => r.name,
    )
    expect(names).toEqual(["app.users", "app.orders", "billing.invoices"])
  })

  test("sort by partitions is descending with name tiebreak", () => {
    const names = visibleRows(fleet, allMeasured, { ...defaults, sort: "partitions" }).map(
      (r) => r.name,
    )
    expect(names).toEqual(["billing.invoices", "app.orders", "app.users"])
  })

  test("partition sort and filtering work with nothing measured", () => {
    const rows = visibleRows(fleet, none, { ...defaults, sort: "partitions" })
    expect(rows.map((r) => r.name)).toEqual(["billing.invoices", "app.orders", "app.users"])
    expect(rows.every((r) => r.messages === null)).toBe(true)
  })

  test("sort by messages sinks unmeasured rows below every measured one", () => {
    const partial: Measured = new Map([
      ["billing.invoices", partitions(OFFSETS["billing.invoices"]!)],
    ])
    const names = visibleRows(fleet, partial, { ...defaults, sort: "messages" }).map((r) => r.name)
    expect(names).toEqual(["billing.invoices", "app.orders", "app.users"])
  })
})

describe("formatRowCount", () => {
  test("an unmeasured count is a dash, not ~0", () => {
    expect(formatRowCount(null)).toBe("—")
    expect(formatRowCount(0n)).toBe("~0")
    expect(formatRowCount(1234n)).toBe("~1,234")
  })
})

describe("windowStart", () => {
  test("no scrolling while everything fits", () => {
    expect(windowStart(4, 5, 10)).toBe(0)
  })

  test("centres the cursor once the list overflows", () => {
    expect(windowStart(50, 100, 10)).toBe(45)
  })

  test("clamps at both ends", () => {
    expect(windowStart(0, 100, 10)).toBe(0)
    expect(windowStart(99, 100, 10)).toBe(90)
  })
})

describe("formatApprox", () => {
  test("groups digits and keeps the tilde", () => {
    expect(formatApprox(0n)).toBe("~0")
    expect(formatApprox(999n)).toBe("~999")
    expect(formatApprox(1234567n)).toBe("~1,234,567")
  })

  test("stays exact beyond Number.MAX_SAFE_INTEGER", () => {
    expect(formatApprox(9007199254740993n)).toBe("~9,007,199,254,740,993")
  })
})

describe("partitionPaneRows", () => {
  test("shows every partition when they fit under the cap", () => {
    expect(partitionPaneRows(3, 20)).toBe(3)
    expect(partitionPaneRows(8, 20)).toBe(8)
  })

  test("caps at PANE_MAX_ROWS so the topic list keeps its height", () => {
    expect(partitionPaneRows(64, 20)).toBe(PANE_MAX_ROWS)
  })

  test("gives way to the list on a short terminal, never to nothing", () => {
    expect(partitionPaneRows(64, 4)).toBe(4)
    expect(partitionPaneRows(64, 0)).toBe(1)
    expect(partitionPaneRows(64, -5)).toBe(1)
  })
})

describe("partitionRangeLabel", () => {
  test("a fitting pane just counts", () => {
    expect(partitionRangeLabel(0, 3, 3)).toBe("3 partitions")
  })

  test("a scrolled pane states the slice and the total", () => {
    expect(partitionRangeLabel(0, 8, 64)).toBe("partitions 1–8 of 64")
    expect(partitionRangeLabel(8, 8, 64)).toBe("partitions 9–16 of 64")
    expect(partitionRangeLabel(56, 8, 64)).toBe("partitions 57–64 of 64")
  })
})
