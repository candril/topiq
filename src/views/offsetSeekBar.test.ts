import { describe, expect, test } from "bun:test"
import type { GroupSeekState } from "@/state.ts"
import { seekBarRows } from "./OffsetSeek.tsx"

// The row count the group list subtracts. Tested on its own because getting it wrong is
// invisible in review and fatal at runtime: the bar renders below the bottom of the screen
// and the seek looks like it never opened (AGENTS.md).

function seek(over: Partial<GroupSeekState> = {}): GroupSeekState {
  return {
    groupId: "orders-projector",
    choice: 0,
    value: null,
    planning: false,
    pending: null,
    ...over,
  }
}

describe("seekBarRows", () => {
  test("a closed bar costs the list nothing", () => {
    expect(seekBarRows(null)).toBe(0)
  })

  test("choosing a target and typing a value cost the same two rows", () => {
    expect(seekBarRows(seek())).toBe(2)
    expect(seekBarRows(seek({ value: "4711" }))).toBe(2)
  })

  test("the in-flight plan is a single line", () => {
    expect(seekBarRows(seek({ planning: true }))).toBe(1)
  })

  test("the confirm dialog is an overlay, so it takes no rows from the list", () => {
    const pending = { prompt: {}, action: {}, plan: {} } as unknown as GroupSeekState["pending"]
    expect(seekBarRows(seek({ pending }))).toBe(0)
  })
})
