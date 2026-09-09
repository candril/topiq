import { describe, expect, test } from "bun:test"
import {
  formatCount,
  measureRate,
  rateLabel,
  SCAN_CAP,
  scanProgressLabel,
  scanRange,
  scanStatusLabel,
} from "./scan.ts"
import { WINDOW_CAP } from "./window.ts"

describe("scanRange", () => {
  test("latest-N scans the whole topic — a scan of the latest 50 is the window", () => {
    expect(scanRange({ kind: "latestN", n: 50 })).toEqual({ kind: "beginning" })
  })

  test("every other range scans as it stands", () => {
    const offset = { kind: "offset", offset: 42n } as const
    const timestamp = { kind: "timestamp", timestamp: new Date(0) } as const
    expect(scanRange(offset)).toBe(offset)
    expect(scanRange(timestamp)).toBe(timestamp)
    expect(scanRange({ kind: "beginning" })).toEqual({ kind: "beginning" })
  })
})

describe("labels", () => {
  test("the hit cap is the window cap", () => {
    expect(SCAN_CAP).toBe(WINDOW_CAP)
  })

  test("counts are grouped, bigint included", () => {
    expect(formatCount(4_800_000)).toBe("4,800,000")
    expect(formatCount(1_234_567n)).toBe("1,234,567")
  })

  test("progress states the plan as approximate, or just the count without one", () => {
    expect(scanProgressLabel(1_234_567, 4_800_000n)).toBe("1,234,567 / ≈4,800,000")
    expect(scanProgressLabel(12, null)).toBe("12 scanned")
  })

  test("capped names the number, so the reader knows they hold the first 10k hits", () => {
    expect(scanStatusLabel("capped")).toBe("capped at 10,000 hits")
    expect(scanStatusLabel("error")).toBe("scan failed")
  })

  test("rate rounds and is absent until measured", () => {
    expect(rateLabel(null)).toBeNull()
    expect(rateLabel(12_345.6)).toBe("12,346 msg/s")
  })
})

describe("measureRate", () => {
  test("keeps the last reading until a full window has elapsed", () => {
    const start = { at: 0, count: 0 }
    const early = measureRate(start, { at: 500, count: 900 }, 7)
    expect(early.rate).toBe(7)
    expect(early.sample).toBe(start)
  })

  test("measures per second over the window and rebases the sample", () => {
    const reading = measureRate({ at: 0, count: 100 }, { at: 2000, count: 2100 }, null)
    expect(reading.rate).toBe(1000)
    expect(reading.sample).toEqual({ at: 2000, count: 2100 })
  })
})
