import { describe, expect, test } from "bun:test"
import type { Command, CommandCategory, CommandId } from "@/commands/types.ts"
import {
  PALETTE_CHROME,
  paletteCapacity,
  paletteEntries,
  paletteRows,
  paletteWindow,
} from "./commandPaletteModel.ts"

function command(id: string, category: CommandCategory): Command {
  return { id: id as CommandId, category, title: id, key: "x", blocked: null }
}

const MATCHES: Command[] = [
  command("general.quit", "General"),
  command("fetch.reload", "Fetch"),
  command("replay.craft", "Replay"),
  command("fetch.offset", "Fetch"),
]

describe("paletteEntries", () => {
  test("sections come in the fixed order, whatever order the matches arrived in", () => {
    expect(
      paletteEntries(MATCHES).map((e) => (e.kind === "header" ? e.category : e.command.id)),
    ).toEqual([
      "Fetch",
      "fetch.reload",
      "fetch.offset",
      "Replay",
      "replay.craft",
      "General",
      "general.quit",
    ])
  })

  test("a command's index stays its position in the match list, not in the section", () => {
    const entries = paletteEntries(MATCHES)
    const offset = entries.find((e) => e.kind === "command" && e.command.id === "fetch.offset")
    expect(offset).toEqual({ kind: "command", command: MATCHES[3]!, index: 3 })
  })

  test("empty sections are dropped, and no matches means no entries", () => {
    expect(paletteEntries([]).length).toBe(0)
    expect(paletteEntries([command("fetch.reload", "Fetch")]).length).toBe(2)
  })
})

describe("geometry", () => {
  test("the overlay never fills the screen, and never shrinks to nothing", () => {
    expect(paletteCapacity(80)).toBeLessThanOrEqual(14)
    expect(paletteCapacity(8)).toBeGreaterThanOrEqual(1)
    expect(paletteCapacity(0)).toBe(1)
  })

  test("capacity leaves room for the app around it", () => {
    expect(paletteCapacity(20)).toBeLessThan(20)
  })

  test("rows are the shown entries plus the chrome — one helper for both", () => {
    expect(paletteRows(3, 40)).toBe(3 + PALETTE_CHROME)
    expect(paletteRows(200, 40)).toBe(paletteCapacity(40) + PALETTE_CHROME)
  })
})

describe("paletteWindow", () => {
  const many: Command[] = Array.from({ length: 20 }, (_, i) =>
    command(`fetch.${i}`, i < 10 ? "Fetch" : "Replay"),
  )

  test("a list that fits is shown whole", () => {
    const entries = paletteEntries(MATCHES)
    expect(paletteWindow(entries, 0, 14)).toEqual(entries)
  })

  test("the highlighted command is always in the window", () => {
    const entries = paletteEntries(many)
    for (const cursor of [0, 7, 14, 19]) {
      const shown = paletteWindow(entries, cursor, 6)
      expect(shown.some((e) => e.kind === "command" && e.index === cursor)).toBe(true)
      expect(shown.length).toBeLessThanOrEqual(6)
    }
  })

  test("a scrolled window keeps the section label above its first row", () => {
    const entries = paletteEntries(many)
    const shown = paletteWindow(entries, 12, 6)
    expect(shown[0]?.kind).toBe("header")
  })
})
