import { describe, expect, test } from "bun:test"
import { fuzzyScore, matchCommands } from "./match.ts"
import type { Command, CommandCategory, CommandId } from "./types.ts"

function command(id: string, title: string, category: CommandCategory = "Fetch"): Command {
  return { id: id as CommandId, category, title, key: "x", blocked: null }
}

const COMMANDS: Command[] = [
  command("fetch.reload", "Reload the window"),
  command("filter.open", "Filter the window", "Filter"),
  command("replay.byteExact", "Replay this message byte-exact", "Replay"),
  command("replay.craft", "New message from the latest schema", "Replay"),
  command("general.quit", "Quit topiq", "General"),
]

describe("fuzzyScore", () => {
  test("an empty query matches everything, neutrally", () => {
    expect(fuzzyScore("anything", "")).toBe(0)
    expect(fuzzyScore("anything", "   ")).toBe(0)
  })

  test("a subsequence matches; a missing character does not", () => {
    expect(fuzzyScore("Reload the window", "rlw")).not.toBeNull()
    expect(fuzzyScore("Reload the window", "rlz")).toBeNull()
  })

  test("case is irrelevant", () => {
    expect(fuzzyScore("Reload the window", "RELOAD")).not.toBeNull()
  })

  test("a contiguous prefix beats scattered hits", () => {
    const contiguous = fuzzyScore("Reload the window", "reload") ?? -Infinity
    const scattered = fuzzyScore("Replay this message byte-exact", "reload") ?? -Infinity
    expect(contiguous).toBeGreaterThan(scattered)
  })

  test("a hit at a word start beats the same hit inside a word", () => {
    const wordStart = fuzzyScore("Reload the window", "w") ?? -Infinity
    const midWord = fuzzyScore("Follow the answer", "w") ?? -Infinity
    expect(wordStart).toBeGreaterThan(midWord)
  })

  test("spaces in the query separate rather than being searched for", () => {
    expect(fuzzyScore("Replay this message byte-exact", "rep byte")).not.toBeNull()
  })
})

describe("matchCommands", () => {
  test("an empty query keeps every command in the builder's order", () => {
    expect(matchCommands(COMMANDS, "").map((c) => c.id)).toEqual(COMMANDS.map((c) => c.id))
  })

  test("non-matching commands are dropped", () => {
    expect(matchCommands(COMMANDS, "quit").map((c) => c.id)).toEqual(["general.quit"])
  })

  test("the section name is searchable, so a category finds its whole group", () => {
    expect(matchCommands(COMMANDS, "replay").map((c) => c.id)).toEqual([
      "replay.byteExact",
      "replay.craft",
    ])
  })

  test("the best match leads", () => {
    expect(matchCommands(COMMANDS, "window")[0]?.id).toBe("fetch.reload")
    expect(matchCommands(COMMANDS, "filter")[0]?.id).toBe("filter.open")
  })

  test("the direct key is shown, not searched — single letters would match everything", () => {
    const keyed: Command[] = [{ ...command("fetch.hideColumn", "Reload the window"), key: "-" }]
    expect(matchCommands(keyed, "-")).toEqual([])
  })
})
