import { describe, expect, test } from "bun:test"
import type { CopyState } from "@/state.ts"
import type { DecodedMessage } from "@/types.ts"
import { copyBarRows, VISIBLE_DESTINATIONS } from "./CopyBar.tsx"

// The row count the message table subtracts is the one the bar draws (AGENTS.md). Two
// counts drift, and the bar then renders past the bottom of the screen — for a write
// prompt that means a keystroke waiting on something nobody can read.

const row = { partition: 0, offset: 1n } as DecodedMessage

function copy(over: Partial<CopyState> = {}): CopyState {
  return { row, choice: 0, topic: null, planning: false, ...over }
}

describe("copyBarRows", () => {
  test("an idle bar draws nothing at all — no permanent hint row", () => {
    expect(copyBarRows(null, 3)).toBe(0)
  })

  test("choosing a destination: a title row, the list, and the not-a-copy line", () => {
    expect(copyBarRows(copy(), 2)).toBe(4)
  })

  test("the list is capped, so a large fleet cannot eat the message rows", () => {
    expect(copyBarRows(copy(), 40)).toBe(VISIBLE_DESTINATIONS + 2)
  })

  test("with no destinations the row that says so still needs its space", () => {
    expect(copyBarRows(copy(), 0)).toBe(3)
  })

  test("naming the topic is the input row plus its hint", () => {
    expect(copyBarRows(copy({ topic: "test-orders" }), 3)).toBe(2)
  })

  test("planning is one line — the two registries are being read", () => {
    expect(copyBarRows(copy({ topic: "t", planning: true }), 3)).toBe(1)
  })
})
