import { describe, expect, test } from "bun:test"
import { appReducer, createInitialState } from "@/state.ts"
import type { AppAction, AppState } from "@/state.ts"

function run(actions: AppAction[], from: AppState = createInitialState()): AppState {
  return actions.reduce(appReducer, from)
}

describe("topicListReducer", () => {
  test("filter typing appends, backspaces, and resets the cursor", () => {
    const state = run([
      { type: "TOPICS_MOVE", delta: 5, rowCount: 10 },
      { type: "TOPICS_FILTER_OPEN" },
      { type: "TOPICS_FILTER_APPEND", char: "a" },
      { type: "TOPICS_FILTER_APPEND", char: "b" },
      { type: "TOPICS_FILTER_BACKSPACE" },
    ])
    expect(state.topics.filter).toBe("a")
    expect(state.topics.filterActive).toBe(true)
    expect(state.topics.cursor).toBe(0)
  })

  test("close keeps the filter, clear drops it", () => {
    const typed = run([{ type: "TOPICS_FILTER_OPEN" }, { type: "TOPICS_FILTER_APPEND", char: "x" }])
    const closed = appReducer(typed, { type: "TOPICS_FILTER_CLOSE" })
    expect(closed.topics.filter).toBe("x")
    expect(closed.topics.filterActive).toBe(false)
    const cleared = appReducer(typed, { type: "TOPICS_FILTER_CLEAR" })
    expect(cleared.topics.filter).toBe("")
    expect(cleared.topics.filterActive).toBe(false)
  })

  test("cursor moves clamp to the row count", () => {
    const state = run([
      { type: "TOPICS_MOVE", delta: -3, rowCount: 5 },
      { type: "TOPICS_MOVE", delta: 99, rowCount: 5 },
    ])
    expect(state.topics.cursor).toBe(4)
    expect(run([{ type: "TOPICS_MOVE", delta: 1, rowCount: 0 }]).topics.cursor).toBe(0)
  })

  test("jump hits both ends", () => {
    const bottom = run([{ type: "TOPICS_JUMP", to: "bottom", rowCount: 7 }])
    expect(bottom.topics.cursor).toBe(6)
    const top = appReducer(bottom, { type: "TOPICS_JUMP", to: "top", rowCount: 7 })
    expect(top.topics.cursor).toBe(0)
  })

  test("internal toggle flips and resets the cursor", () => {
    const state = run([
      { type: "TOPICS_MOVE", delta: 3, rowCount: 10 },
      { type: "TOPICS_TOGGLE_INTERNAL" },
    ])
    expect(state.topics.showInternal).toBe(true)
    expect(state.topics.cursor).toBe(0)
  })

  test("the partition pane scrolls within its offset bounds", () => {
    const open = run([{ type: "TOPICS_TOGGLE_DETAIL" }])
    const down = run(
      [
        { type: "TOPICS_DETAIL_SCROLL", delta: 1, maxOffset: 56 },
        { type: "TOPICS_DETAIL_SCROLL", delta: 1, maxOffset: 56 },
      ],
      open,
    )
    expect(down.topics.detailOffset).toBe(2)
    expect(
      run([{ type: "TOPICS_DETAIL_SCROLL", delta: 99, maxOffset: 56 }], down).topics.detailOffset,
    ).toBe(56)
    expect(
      run([{ type: "TOPICS_DETAIL_SCROLL", delta: -99, maxOffset: 56 }], down).topics.detailOffset,
    ).toBe(0)
  })

  test("a pane scrolled past the end rewinds when the cursor leaves the topic", () => {
    const scrolled = run([
      { type: "TOPICS_TOGGLE_DETAIL" },
      { type: "TOPICS_DETAIL_SCROLL", delta: 8, maxOffset: 56 },
    ])
    expect(scrolled.topics.detailOffset).toBe(8)
    for (const action of [
      { type: "TOPICS_MOVE", delta: 1, rowCount: 10 },
      { type: "TOPICS_JUMP", to: "bottom", rowCount: 10 },
      { type: "TOPICS_CYCLE_SORT" },
      { type: "TOPICS_TOGGLE_INTERNAL" },
      { type: "TOPICS_FILTER_APPEND", char: "a" },
      { type: "TOPICS_TOGGLE_DETAIL" },
    ] satisfies AppAction[]) {
      expect(appReducer(scrolled, action).topics.detailOffset).toBe(0)
    }
  })

  test("sort cycles name → messages → partitions → name", () => {
    let state = createInitialState()
    const seen = [state.topics.sort]
    for (let i = 0; i < 3; i++) {
      state = appReducer(state, { type: "TOPICS_CYCLE_SORT" })
      seen.push(state.topics.sort)
    }
    expect(seen).toEqual(["name", "messages", "partitions", "name"])
  })
})

describe("filter text comes from the <input> (spec 006)", () => {
  test("setting the filter sends the cursor home", () => {
    let state = appReducer(createInitialState(), { type: "TOPICS_FILTER_OPEN" })
    state = appReducer(state, { type: "TOPICS_MOVE", delta: 4, rowCount: 10 })
    expect(state.topics.cursor).toBe(4)
    state = appReducer(state, { type: "TOPICS_FILTER_SET", filter: "orders" })
    expect(state.topics.filter).toBe("orders")
    // The row the cursor was on belongs to the previous result set.
    expect(state.topics.cursor).toBe(0)
  })

  test("non-ASCII is accepted — the old hand-rolled guard rejected it", () => {
    const state = appReducer(createInitialState(), {
      type: "TOPICS_FILTER_SET",
      filter: "größe-tröt",
    })
    expect(state.topics.filter).toBe("größe-tröt")
  })
})
