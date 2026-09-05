import { describe, expect, test } from "bun:test"
import type { AppAction } from "@/state.ts"
import { runCommand, runPaletteCommand, type CommandActions } from "./run.ts"
import type { Command, CommandId, ViewActions } from "./types.ts"

function harness(view: ViewActions = {}) {
  const dispatched: AppAction[] = []
  let quit = 0
  const actions: CommandActions = {
    dispatch: (action) => dispatched.push(action as AppAction),
    quit: () => {
      quit += 1
    },
    view,
  }
  return { actions, dispatched, quits: () => quit }
}

function command(id: CommandId, blocked: string | null = null): Command {
  return { id, category: "Replay", title: "Replay this message byte-exact", key: "p", blocked }
}

describe("runCommand", () => {
  test("a dispatch-only command dispatches exactly its action", () => {
    const { actions, dispatched } = harness()
    runCommand("fetch.beginning", actions)
    expect(dispatched).toEqual([{ type: "MSGS_SET_RANGE", range: { kind: "beginning" } }])
  })

  test("view-backed commands call the view, not the reducer", () => {
    const calls: string[] = []
    const { actions, dispatched } = harness({
      replay: () => calls.push("replay"),
      craft: () => calls.push("craft"),
      seekOffsets: () => calls.push("seek"),
    })
    runCommand("replay.byteExact", actions)
    runCommand("replay.craft", actions)
    runCommand("groups.seek", actions)
    expect(calls).toEqual(["replay", "craft", "seek"])
    expect(dispatched).toEqual([])
  })

  test("quitting is App's, not a reducer's", () => {
    const { actions, quits, dispatched } = harness()
    runCommand("general.quit", actions)
    expect(quits()).toBe(1)
    expect(dispatched).toEqual([])
  })

  test("a view-backed command with nothing registered says so instead of doing nothing", () => {
    const { actions, dispatched } = harness()
    runCommand("replay.byteExact", actions)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({ type: "SHOW_STATUS", kind: "error" })
  })

  test("navigation commands ascend one level each", () => {
    const { actions, dispatched } = harness()
    runCommand("nav.topics", actions)
    runCommand("nav.picker", actions)
    runCommand("groups.close", actions)
    expect(dispatched).toEqual([
      { type: "SELECT_TOPIC", topic: null },
      { type: "SELECT_CLUSTER", cluster: null },
      { type: "GROUPS_CLOSE" },
    ])
  })
})

describe("runPaletteCommand", () => {
  test("a blocked command reports the reason and does not act", () => {
    const calls: string[] = []
    const { actions, dispatched } = harness({ replay: () => calls.push("replay") })
    runPaletteCommand(command("replay.byteExact", "writes are disabled on core-prod"), actions)
    expect(calls).toEqual([])
    expect(dispatched).toEqual([
      {
        type: "SHOW_STATUS",
        message: "replay this message byte-exact: writes are disabled on core-prod",
        kind: "error",
      },
    ])
  })

  test("an unblocked command runs", () => {
    const calls: string[] = []
    const { actions } = harness({ replay: () => calls.push("replay") })
    runPaletteCommand(command("replay.byteExact"), actions)
    expect(calls).toEqual(["replay"])
  })
})
