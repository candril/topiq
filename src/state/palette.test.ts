import { describe, expect, test } from "bun:test"
import { appReducer, createInitialState } from "@/state.ts"

describe("palette reducer", () => {
  test("it starts closed and opens empty", () => {
    const closed = createInitialState()
    expect(closed.palette).toBeNull()
    expect(appReducer(closed, { type: "PALETTE_OPEN" }).palette).toEqual({ query: "", cursor: 0 })
  })

  test("a second open forgets the last query — a stale one hides what you came for", () => {
    const open = appReducer(createInitialState(), { type: "PALETTE_OPEN" })
    const typed = appReducer(open, { type: "PALETTE_SET", query: "replay" })
    const reopened = appReducer(appReducer(typed, { type: "PALETTE_CLOSE" }), {
      type: "PALETTE_OPEN",
    })
    expect(reopened.palette).toEqual({ query: "", cursor: 0 })
  })

  test("typing sends the highlight back to the top", () => {
    const open = appReducer(createInitialState(), { type: "PALETTE_OPEN" })
    const moved = appReducer(open, { type: "PALETTE_MOVE", delta: 3, rowCount: 10 })
    expect(moved.palette?.cursor).toBe(3)
    expect(appReducer(moved, { type: "PALETTE_SET", query: "re" }).palette?.cursor).toBe(0)
  })

  test("the highlight clamps to the matches", () => {
    const open = appReducer(createInitialState(), { type: "PALETTE_OPEN" })
    const down = appReducer(open, { type: "PALETTE_MOVE", delta: 99, rowCount: 4 })
    expect(down.palette?.cursor).toBe(3)
    expect(
      appReducer(down, { type: "PALETTE_MOVE", delta: -99, rowCount: 4 }).palette?.cursor,
    ).toBe(0)
  })

  test("no matches leaves the highlight at zero rather than at -1", () => {
    const open = appReducer(createInitialState(), { type: "PALETTE_OPEN" })
    expect(appReducer(open, { type: "PALETTE_MOVE", delta: 1, rowCount: 0 }).palette?.cursor).toBe(
      0,
    )
  })

  test("palette actions on a closed palette change nothing", () => {
    const closed = createInitialState()
    expect(appReducer(closed, { type: "PALETTE_MOVE", delta: 1, rowCount: 5 })).toBe(closed)
    expect(appReducer(closed, { type: "PALETTE_SET", query: "x" })).toBe(closed)
  })
})
