import { describe, expect, test } from "bun:test"
import { appReducer, createInitialState } from "@/state.ts"

describe("picker reducer", () => {
  test("PICKER_MOVE clamps to the row range", () => {
    const state = createInitialState()
    const down = appReducer(state, { type: "PICKER_MOVE", delta: 5, rowCount: 3 })
    expect(down.picker.cursor).toBe(2)
    const up = appReducer(down, { type: "PICKER_MOVE", delta: -10, rowCount: 3 })
    expect(up.picker.cursor).toBe(0)
  })

  test("PICKER_JUMP hits top and bottom", () => {
    const state = createInitialState()
    const bottom = appReducer(state, { type: "PICKER_JUMP", to: "bottom", rowCount: 4 })
    expect(bottom.picker.cursor).toBe(3)
    expect(appReducer(bottom, { type: "PICKER_JUMP", to: "top", rowCount: 4 }).picker.cursor).toBe(
      0,
    )
  })

  test("cursor survives selecting a cluster — ascending back keeps the position", () => {
    const moved = appReducer(createInitialState(), { type: "PICKER_MOVE", delta: 2, rowCount: 5 })
    const selected = appReducer(moved, { type: "SELECT_CLUSTER", cluster: "orders-test" })
    expect(selected.picker.cursor).toBe(2)
  })

  test("SELECT_CLUSTER resets the topic-list slice — filters are cluster-local", () => {
    const filtered = appReducer(createInitialState({ cluster: "a" }), {
      type: "TOPICS_FILTER_APPEND",
      char: "x",
    })
    const switched = appReducer(filtered, { type: "SELECT_CLUSTER", cluster: "b" })
    expect(switched.topics.filter).toBe("")
  })
})
