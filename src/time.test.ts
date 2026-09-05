import { describe, expect, test } from "bun:test"
import { relativeAge } from "./time.ts"

const NOW = new Date("2026-08-27T12:00:00.000Z")

describe("relativeAge", () => {
  test("scales through two-unit steps", () => {
    const at = (ms: number) => relativeAge(new Date(NOW.getTime() - ms), NOW)
    expect(at(12_000)).toBe("12s ago")
    expect(at(5 * 60_000 + 3_000)).toBe("5m 3s ago")
    expect(at(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m ago")
    expect(at(49 * 3_600_000)).toBe("2d 1h ago")
  })

  test("a future timestamp is called out, not clamped to zero", () => {
    expect(relativeAge(new Date(NOW.getTime() + 1000), NOW)).toBe("in the future")
  })
})
