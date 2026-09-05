import { describe, expect, test } from "bun:test"
import { helpColumns, type HelpSection } from "./HelpPanel.tsx"

const section = (name: string, rows: number): HelpSection => [
  name,
  Array.from({ length: rows }, (_, i) => [`k${i}`, `does ${i}`] as [string, string]),
]

describe("helpColumns", () => {
  test("everything in one column when it fits", () => {
    const columns = helpColumns([section("a", 3), section("b", 3)], 40)
    expect(columns).toHaveLength(1)
  })

  test("spills into more columns rather than off the bottom of the screen", () => {
    // 11 sections of 6 rows each = 88 rows; a 50-row terminal cannot hold that in one
    // column, and drawing it anyway is what corrupted the panel.
    const sections = Array.from({ length: 11 }, (_, i) => section(`s${i}`, 6))
    const columns = helpColumns(sections, 50)
    expect(columns.length).toBeGreaterThan(1)
    for (const column of columns) {
      const rows = column.reduce((sum, s) => sum + s[1].length + 2, 0)
      expect(rows).toBeLessThanOrEqual(50 - 4)
    }
  })

  test("section order is preserved across the columns", () => {
    const sections = Array.from({ length: 8 }, (_, i) => section(`s${i}`, 5))
    const flat = helpColumns(sections, 20)
      .flat()
      .map((s) => s[0])
    expect(flat).toEqual(sections.map((s) => s[0]))
  })

  test("a section taller than the budget still gets drawn, alone in its column", () => {
    const columns = helpColumns([section("huge", 40), section("small", 2)], 20)
    expect(columns[0]).toHaveLength(1)
    expect(columns[0]![0]![0]).toBe("huge")
  })

  test("a tiny terminal does not produce an empty column", () => {
    for (const height of [1, 2, 4, 8]) {
      const columns = helpColumns([section("a", 3), section("b", 3)], height)
      expect(columns.every((c) => c.length > 0)).toBe(true)
    }
  })
})
