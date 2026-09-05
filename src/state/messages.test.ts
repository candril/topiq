import { describe, expect, test } from "bun:test"
import { appReducer, createInitialState } from "@/state.ts"
import type { AppState, PendingWrite } from "@/state.ts"
import type { DecodedMessage } from "@/types.ts"

function withPrompt(state: AppState): AppState {
  return appReducer(state, { type: "MSGS_PROMPT_OPEN", mode: "offset" })
}

function withFilter(state: AppState, query: string): AppState {
  let next = appReducer(state, { type: "MSGS_FILTER_OPEN" })
  for (const char of query) {
    next = appReducer(next, { type: "MSGS_FILTER_APPEND", char })
  }
  return next
}

describe("messagesReducer", () => {
  test("default window is latest 50", () => {
    expect(createInitialState().messages.range).toEqual({ kind: "latestN", n: 50 })
  })

  test("cursor moves clamp to the row count", () => {
    let state = createInitialState()
    state = appReducer(state, { type: "MSGS_MOVE", delta: -1, rowCount: 3 })
    expect(state.messages.cursor).toBe(0)
    state = appReducer(state, { type: "MSGS_MOVE", delta: 10, rowCount: 3 })
    expect(state.messages.cursor).toBe(2)
    state = appReducer(state, { type: "MSGS_JUMP", to: "top", rowCount: 3 })
    expect(state.messages.cursor).toBe(0)
    state = appReducer(state, { type: "MSGS_JUMP", to: "bottom", rowCount: 0 })
    expect(state.messages.cursor).toBe(0)
  })

  test("prompt captures, backspaces and cancels", () => {
    let state = withPrompt(createInitialState())
    state = appReducer(state, { type: "MSGS_PROMPT_APPEND", char: "1" })
    state = appReducer(state, { type: "MSGS_PROMPT_APPEND", char: "2" })
    state = appReducer(state, { type: "MSGS_PROMPT_BACKSPACE" })
    expect(state.messages.prompt).toEqual({ mode: "offset", input: "1" })
    state = appReducer(state, { type: "MSGS_PROMPT_CANCEL" })
    expect(state.messages.prompt).toBeNull()
  })

  test("append without an open prompt is a no-op", () => {
    const state = createInitialState()
    expect(appReducer(state, { type: "MSGS_PROMPT_APPEND", char: "x" })).toBe(state)
  })

  test("setting a range closes the prompt, resets the cursor and mirrors mode", () => {
    let state = withPrompt(createInitialState())
    state = appReducer(state, { type: "MSGS_MOVE", delta: 5, rowCount: 10 })
    state = appReducer(state, { type: "MSGS_SET_RANGE", range: { kind: "offset", offset: 7n } })
    expect(state.messages).toEqual({
      cursor: 0,
      range: { kind: "offset", offset: 7n },
      prompt: null,
      filter: { query: "", active: false },
      follow: { active: false, paused: false, pinned: false },
      confirmTyped: "",
      column: 0,
      copy: null,
      hiddenColumns: [],
      columnPicker: null,
      sort: { path: null, direction: "asc" },
      jsEditor: null,
      confirm: null,
    })
    expect(state.mode).toBe("offset")
  })

  test("a range change keeps the filter — it is a question about the data, not the window", () => {
    let state = withFilter(createInitialState(), "value.Name:ada")
    state = appReducer(state, { type: "MSGS_SET_RANGE", range: { kind: "beginning" } })
    expect(state.messages.filter).toEqual({ query: "value.Name:ada", active: true })
  })

  test("the filter starts empty and closed", () => {
    expect(createInitialState().messages.filter).toEqual({ query: "", active: false })
  })

  test("typing captures spaces — they separate grammar terms", () => {
    const state = withFilter(createInitialState(), "key:1 value.Name:ada")
    expect(state.messages.filter).toEqual({ query: "key:1 value.Name:ada", active: true })
  })

  test("enter closes the bar but keeps the applied filter", () => {
    let state = withFilter(createInitialState(), "ada")
    state = appReducer(state, { type: "MSGS_FILTER_CLOSE" })
    expect(state.messages.filter).toEqual({ query: "ada", active: false })
  })

  test("esc clears the filter and closes the bar", () => {
    let state = withFilter(createInitialState(), "ada")
    state = appReducer(state, { type: "MSGS_FILTER_CLEAR" })
    expect(state.messages.filter).toEqual({ query: "", active: false })
  })

  test("backspace edits the query", () => {
    let state = withFilter(createInitialState(), "adax")
    state = appReducer(state, { type: "MSGS_FILTER_BACKSPACE" })
    expect(state.messages.filter.query).toBe("ada")
  })

  test("backspacing an empty query is harmless", () => {
    const state = appReducer(createInitialState(), { type: "MSGS_FILTER_BACKSPACE" })
    expect(state.messages.filter.query).toBe("")
  })

  test("every filter edit snaps the cursor back to the top of the new result set", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_MOVE", delta: 5, rowCount: 10 })
    expect(state.messages.cursor).toBe(5)
    state = appReducer(state, { type: "MSGS_FILTER_APPEND", char: "a" })
    expect(state.messages.cursor).toBe(0)
    state = appReducer(state, { type: "MSGS_MOVE", delta: 3, rowCount: 10 })
    state = appReducer(state, { type: "MSGS_FILTER_BACKSPACE" })
    expect(state.messages.cursor).toBe(0)
    state = appReducer(state, { type: "MSGS_MOVE", delta: 3, rowCount: 10 })
    state = appReducer(state, { type: "MSGS_FILTER_CLEAR" })
    expect(state.messages.cursor).toBe(0)
  })

  test("closing the bar leaves the cursor where it is", () => {
    let state = appReducer(withFilter(createInitialState(), "ada"), {
      type: "MSGS_MOVE",
      delta: 2,
      rowCount: 10,
    })
    state = appReducer(state, { type: "MSGS_FILTER_CLOSE" })
    expect(state.messages.cursor).toBe(2)
  })

  test("follow starts off, and toggling it on pins the cursor to the newest row", () => {
    let state = createInitialState()
    expect(state.messages.follow).toEqual({ active: false, paused: false, pinned: false })
    state = appReducer(state, { type: "MSGS_FOLLOW_TOGGLE" })
    expect(state.messages.follow).toEqual({ active: true, paused: false, pinned: true })
    state = appReducer(state, { type: "MSGS_FOLLOW_TOGGLE" })
    expect(state.messages.follow).toEqual({ active: false, paused: false, pinned: false })
  })

  test("pause toggles without leaving follow, and is a no-op while not following", () => {
    const off = createInitialState()
    expect(appReducer(off, { type: "MSGS_FOLLOW_PAUSE_TOGGLE" })).toBe(off)
    let state = appReducer(off, { type: "MSGS_FOLLOW_TOGGLE" })
    state = appReducer(state, { type: "MSGS_FOLLOW_PAUSE_TOGGLE" })
    expect(state.messages.follow).toEqual({ active: true, paused: true, pinned: true })
    state = appReducer(state, { type: "MSGS_FOLLOW_PAUSE_TOGGLE" })
    expect(state.messages.follow.paused).toBe(false)
    expect(state.messages.follow.active).toBe(true)
  })

  test("moving off the newest row unpins; moving down at the bottom does not", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_FOLLOW_TOGGLE" })
    state = appReducer(state, { type: "MSGS_MOVE", delta: 1, rowCount: 10 })
    expect(state.messages.follow.pinned).toBe(true)
    expect(state.messages.cursor).toBe(9)
    state = appReducer(state, { type: "MSGS_MOVE", delta: -1, rowCount: 10 })
    expect(state.messages.follow.pinned).toBe(false)
    // Relative from the newest row, not from the stale stored cursor.
    expect(state.messages.cursor).toBe(8)
  })

  test("G rejoins the tail, g leaves it", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_FOLLOW_TOGGLE" })
    state = appReducer(state, { type: "MSGS_MOVE", delta: -3, rowCount: 20 })
    expect(state.messages.follow.pinned).toBe(false)
    state = appReducer(state, { type: "MSGS_JUMP", to: "bottom", rowCount: 20 })
    expect(state.messages.follow.pinned).toBe(true)
    state = appReducer(state, { type: "MSGS_JUMP", to: "top", rowCount: 20 })
    expect(state.messages.follow.pinned).toBe(false)
    expect(state.messages.cursor).toBe(0)
  })

  test("G without following never pins — there is no tail to rejoin", () => {
    const state = appReducer(createInitialState(), {
      type: "MSGS_JUMP",
      to: "bottom",
      rowCount: 5,
    })
    expect(state.messages.follow.pinned).toBe(false)
    expect(state.messages.cursor).toBe(4)
  })

  test("a range change leaves follow — it tails the end of the window it started on", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_FOLLOW_TOGGLE" })
    state = appReducer(state, { type: "MSGS_SET_RANGE", range: { kind: "beginning" } })
    expect(state.messages.follow).toEqual({ active: false, paused: false, pinned: false })
  })

  test("selecting a topic resets the window state", () => {
    let state = createInitialState()
    state = appReducer(state, { type: "MSGS_SET_RANGE", range: { kind: "beginning" } })
    state = appReducer(state, { type: "MSGS_MOVE", delta: 3, rowCount: 5 })
    state = withFilter(state, "ada")
    state = appReducer(state, { type: "SELECT_TOPIC", topic: "orders" })
    expect(state.messages.cursor).toBe(0)
    expect(state.messages.range).toEqual({ kind: "latestN", n: 50 })
    // Field paths are schema-local: carrying `value.Name:ada` to the next topic would
    // silently show an empty window (spec 010).
    expect(state.messages.filter).toEqual({ query: "", active: false })
  })
})

describe("column cursor and sort (spec 024)", () => {
  test("column moves are clamped to the visible column set", () => {
    let state = appReducer(createInitialState(), {
      type: "MSGS_COLUMN_MOVE",
      delta: 1,
      columnCount: 3,
    })
    expect(state.messages.column).toBe(1)
    state = appReducer(state, { type: "MSGS_COLUMN_MOVE", delta: 5, columnCount: 3 })
    expect(state.messages.column).toBe(2)
    state = appReducer(state, { type: "MSGS_COLUMN_MOVE", delta: -9, columnCount: 3 })
    expect(state.messages.column).toBe(0)
  })

  test("no columns pins the cursor at zero rather than going negative", () => {
    const state = appReducer(createInitialState(), {
      type: "MSGS_COLUMN_MOVE",
      delta: 1,
      columnCount: 0,
    })
    expect(state.messages.column).toBe(0)
  })

  test("first/last jump", () => {
    let state = appReducer(createInitialState(), {
      type: "MSGS_COLUMN_JUMP",
      to: "last",
      columnCount: 4,
    })
    expect(state.messages.column).toBe(3)
    state = appReducer(state, { type: "MSGS_COLUMN_JUMP", to: "first", columnCount: 4 })
    expect(state.messages.column).toBe(0)
  })

  test("sort cycles and sends the row cursor back to the top", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_MOVE", delta: 4, rowCount: 10 })
    state = appReducer(state, { type: "MSGS_SORT_CYCLE", path: "Id" })
    expect(state.messages.sort).toEqual({ path: "Id", direction: "asc" })
    expect(state.messages.cursor).toBe(0)
    state = appReducer(state, { type: "MSGS_SORT_CYCLE", path: "Id" })
    expect(state.messages.sort.direction).toBe("desc")
    state = appReducer(state, { type: "MSGS_SORT_CYCLE", path: "Id" })
    expect(state.messages.sort.path).toBeNull()
  })

  test("a range change drops the sort with the window it belonged to", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_SORT_CYCLE", path: "Id" })
    state = appReducer(state, { type: "MSGS_SET_RANGE", range: { kind: "beginning" } })
    expect(state.messages.sort.path).toBeNull()
    expect(state.messages.column).toBe(0)
  })
})

describe("JS editor (spec 011)", () => {
  test("opens seeded, mirrors the textarea, and applies as a =-prefixed filter", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_JS_OPEN", source: "" })
    expect(state.messages.jsEditor).toBe("")
    state = appReducer(state, { type: "MSGS_JS_SET", source: "key\n> 1n" })
    expect(state.messages.jsEditor).toBe("key\n> 1n")
    state = appReducer(state, { type: "MSGS_JS_APPLY" })
    expect(state.messages.jsEditor).toBeNull()
    expect(state.messages.filter.query).toBe("=key\n> 1n")
    expect(state.messages.filter.active).toBe(false)
  })

  test("cancel discards the draft and leaves the filter alone", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_JS_OPEN", source: "abc" })
    state = appReducer(state, { type: "MSGS_JS_CANCEL" })
    expect(state.messages.jsEditor).toBeNull()
    expect(state.messages.filter.query).toBe("")
  })

  test("applying an empty editor clears the filter instead of filtering on nothing", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_JS_OPEN", source: "  " })
    state = appReducer(state, { type: "MSGS_JS_APPLY" })
    expect(state.messages.filter.query).toBe("")
  })

  test("editor input is ignored when the box is closed", () => {
    const state = createInitialState()
    expect(appReducer(state, { type: "MSGS_JS_SET", source: "x" })).toBe(state)
  })
})

describe("column selection (spec 024 P2)", () => {
  test("hiding is a toggle, and it resets the column cursor", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_MOVE", delta: 0, rowCount: 1 })
    state = appReducer(state, { type: "MSGS_COLUMN_MOVE", delta: 2, columnCount: 5 })
    expect(state.messages.column).toBe(2)
    state = appReducer(state, { type: "MSGS_COLUMN_HIDE", path: "EventType" })
    expect(state.messages.hiddenColumns).toEqual(["EventType"])
    // The cursor indexes the visible set — leaving it put would move it to another column.
    expect(state.messages.column).toBe(0)
    state = appReducer(state, { type: "MSGS_COLUMN_HIDE", path: "EventType" })
    expect(state.messages.hiddenColumns).toEqual([])
  })

  test("the picker opens, moves within bounds, and closes", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_COLUMNS_OPEN" })
    expect(state.messages.columnPicker).toBe(0)
    state = appReducer(state, { type: "MSGS_COLUMNS_MOVE", delta: 3, rowCount: 2 })
    expect(state.messages.columnPicker).toBe(1)
    state = appReducer(state, { type: "MSGS_COLUMNS_MOVE", delta: -9, rowCount: 2 })
    expect(state.messages.columnPicker).toBe(0)
    state = appReducer(state, { type: "MSGS_COLUMNS_CLOSE" })
    expect(state.messages.columnPicker).toBeNull()
  })

  test("reset shows everything again", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_COLUMN_HIDE", path: "a" })
    state = appReducer(state, { type: "MSGS_COLUMNS_TOGGLE", path: "b" })
    expect(state.messages.hiddenColumns).toEqual(["a", "b"])
    state = appReducer(state, { type: "MSGS_COLUMNS_RESET" })
    expect(state.messages.hiddenColumns).toEqual([])
  })

  test("a chosen column set survives a range change — it describes the topic, not the window", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_COLUMN_HIDE", path: "Noisy" })
    state = appReducer(state, { type: "MSGS_SET_RANGE", range: { kind: "beginning" } })
    expect(state.messages.hiddenColumns).toEqual(["Noisy"])
    expect(state.messages.columnPicker).toBeNull()
  })

  test("moving in a closed picker is not handled", () => {
    const state = createInitialState()
    expect(appReducer(state, { type: "MSGS_COLUMNS_MOVE", delta: 1, rowCount: 3 })).toBe(state)
  })
})

describe("write confirmation", () => {
  const pending: PendingWrite = {
    prompt: {
      kind: "replay",
      title: "Replay 1 message",
      lines: [],
      warnings: [],
      confirmKey: "R",
      hint: "shift+R to replay · esc to cancel",
      prod: false,
      typeToConfirm: null,
    },
    action: {
      kind: "replay",
      topic: "dg-orders",
      count: 1,
      oldest: new Date("2026-08-28T11:00:00Z"),
    },
    produce: { topic: "dg-orders", records: [{ key: null, value: null, headers: {} }] },
    cluster: "orders-test",
  }

  test("no write is pending by default", () => {
    expect(createInitialState().messages.confirm).toBeNull()
  })

  test("open holds the prompt and the exact bytes; close drops both", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_CONFIRM_OPEN", pending })
    expect(state.messages.confirm).toBe(pending)
    state = appReducer(state, { type: "MSGS_CONFIRM_CLOSE" })
    expect(state.messages.confirm).toBeNull()
  })

  test("a new window drops a pending write — its bytes describe the old one", () => {
    let state = appReducer(createInitialState(), { type: "MSGS_CONFIRM_OPEN", pending })
    state = appReducer(state, { type: "MSGS_SET_RANGE", range: { kind: "beginning" } })
    expect(state.messages.confirm).toBeNull()
  })
})

describe("cross-cluster copy bar", () => {
  const row = { partition: 2, offset: 99n } as DecodedMessage
  const pending: PendingWrite = {
    prompt: {
      kind: "copy",
      title: "Copy 1 message across clusters — re-encoded, not byte-exact",
      lines: [],
      warnings: [],
      confirmKey: "C",
      hint: "shift+C to copy · esc to cancel",
      prod: false,
      typeToConfirm: null,
    },
    action: {
      kind: "copy",
      topic: "test-orders",
      count: 1,
      oldest: new Date("2026-08-28T11:00:00Z"),
      from: {
        name: "orders-prod",
        brokers: ["b:9092"],
        registry: "https://r",
        sasl: { mechanism: "scram-sha-256", username: "u" },
        passwordCmd: "echo x",
        allowWrite: false,
      },
      fromTopic: "dg-orders",
      schemas: [],
    },
    produce: { topic: "test-orders", records: [] },
    cluster: "orders-test",
  }

  function opened(): AppState {
    return appReducer(createInitialState(), { type: "MSGS_COPY_OPEN", row })
  }

  test("opens on the message it was pressed on, at the first destination", () => {
    const state = opened()
    expect(state.messages.copy).toEqual({ row, choice: 0, topic: null, planning: false })
  })

  test("the cursor is clamped to the destinations that exist", () => {
    let state = opened()
    state = appReducer(state, { type: "MSGS_COPY_MOVE", delta: 5, rowCount: 2 })
    expect(state.messages.copy?.choice).toBe(1)
    state = appReducer(state, { type: "MSGS_COPY_MOVE", delta: -5, rowCount: 2 })
    expect(state.messages.copy?.choice).toBe(0)
  })

  test("moving with the bar closed is not handled", () => {
    const state = createInitialState()
    expect(appReducer(state, { type: "MSGS_COPY_MOVE", delta: 1, rowCount: 2 })).toBe(state)
  })

  test("choosing a destination moves on to its topic", () => {
    const state = appReducer(opened(), { type: "MSGS_COPY_TOPIC", topic: "test-orders" })
    expect(state.messages.copy?.topic).toBe("test-orders")
  })

  test("the confirm dialog replaces the bar — one answer to one question", () => {
    let state = appReducer(opened(), { type: "MSGS_COPY_TOPIC", topic: "test-orders" })
    state = appReducer(state, { type: "MSGS_CONFIRM_OPEN", pending })
    expect(state.messages.copy).toBeNull()
    expect(state.messages.confirm).toBe(pending)
  })

  test("a new window closes the bar — the message it names is no longer loaded", () => {
    let state = opened()
    state = appReducer(state, { type: "MSGS_SET_RANGE", range: { kind: "beginning" } })
    expect(state.messages.copy).toBeNull()
  })
})
