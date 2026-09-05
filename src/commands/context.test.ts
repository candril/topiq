import { describe, expect, test } from "bun:test"
import type { ClusterProfile } from "@/config/schema.ts"
import { appReducer, createInitialState, type AppState } from "@/state.ts"
import { commandContext, currentView, keyboardOwned } from "./context.ts"
import { NO_FOCUS } from "./types.ts"

const PROFILE: ClusterProfile = {
  name: "core-test",
  brokers: ["broker:9092"],
  registry: "https://registry",
  sasl: { mechanism: "scram-sha-256", username: "topiq" },
  passwordCmd: "true",
  allowWrite: true,
}

const READ_ONLY: ClusterProfile = { ...PROFILE, name: "core-prod", allowWrite: false }

function stateWith(overrides: Partial<AppState> = {}): AppState {
  return createInitialState({ cluster: "core-test", ...overrides })
}

describe("currentView", () => {
  test("no cluster, or no connection yet, is the picker", () => {
    expect(currentView(createInitialState(), null)).toBe("picker")
    expect(currentView(stateWith(), null)).toBe("picker")
  })

  test("connected with no topic is the topic list, with one the table", () => {
    expect(currentView(stateWith(), PROFILE)).toBe("topics")
    expect(currentView(stateWith({ topic: "dg-orders" }), PROFILE)).toBe("messages")
  })

  test("the group view sits over the table, as App renders it", () => {
    const groups = appReducer(stateWith({ topic: "dg-orders" }), {
      type: "GROUPS_OPEN",
      topic: "dg-orders",
    })
    expect(currentView(groups, PROFILE)).toBe("groups")
  })
})

describe("commandContext", () => {
  test("a read-only cluster's reason travels with the context (spec 019)", () => {
    const ctx = commandContext({
      state: stateWith({ topic: "dg-orders" }),
      profile: READ_ONLY,
      focus: NO_FOCUS,
      copyDestinations: 0,
    })
    expect(ctx.writeBlocked).toContain("core-prod")
  })

  test("a writable cluster blocks nothing", () => {
    const ctx = commandContext({
      state: stateWith({ topic: "dg-orders" }),
      profile: PROFILE,
      focus: NO_FOCUS,
      copyDestinations: 1,
    })
    expect(ctx.writeBlocked).toBeNull()
    expect(ctx.copyDestinations).toBe(1)
  })

  test("the filter and follow state come straight from the reducer", () => {
    const filtered = appReducer(stateWith({ topic: "dg-orders" }), {
      type: "MSGS_FILTER_SET",
      query: "status:paid",
    })
    const following = appReducer(filtered, { type: "MSGS_FOLLOW_TOGGLE" })
    const ctx = commandContext({
      state: following,
      profile: PROFILE,
      focus: NO_FOCUS,
      copyDestinations: 0,
    })
    expect(ctx.filterQuery).toBe("status:paid")
    expect(ctx.follow.active).toBe(true)
  })
})

describe("keyboardOwned — the palette's precedence rule (specs 020, 021)", () => {
  test("a base view owns nothing: the chord is free", () => {
    expect(keyboardOwned(createInitialState())).toBe(false)
    expect(keyboardOwned(stateWith())).toBe(false)
    expect(keyboardOwned(stateWith({ topic: "dg-orders" }))).toBe(false)
  })

  test("an open overlay owns the keyboard", () => {
    expect(keyboardOwned(stateWith({ helpOpen: true }))).toBe(true)
    expect(keyboardOwned(stateWith({ palette: { query: "", cursor: 0 } }))).toBe(true)
  })

  test("every capture in the message table owns it", () => {
    const table = stateWith({ topic: "dg-orders" })
    const captures: AppState[] = [
      appReducer(table, { type: "MSGS_FILTER_OPEN" }),
      appReducer(table, { type: "MSGS_PROMPT_OPEN", mode: "offset" }),
      appReducer(table, { type: "MSGS_JS_OPEN", source: "" }),
      appReducer(table, { type: "MSGS_COLUMNS_OPEN" }),
    ]
    for (const state of captures) {
      expect(keyboardOwned(state)).toBe(true)
    }
  })

  test("the topic filter owns it, but only while the topic list is the view", () => {
    const typing = appReducer(stateWith(), { type: "TOPICS_FILTER_OPEN" })
    expect(keyboardOwned(typing)).toBe(true)
    // Descended into a topic: the table is on screen and its own captures decide.
    expect(keyboardOwned({ ...typing, topic: "dg-orders" })).toBe(false)
  })

  test("the group view's captures win over the table's, as App renders them", () => {
    const groups = appReducer(stateWith({ topic: "dg-orders" }), {
      type: "GROUPS_OPEN",
      topic: "dg-orders",
    })
    expect(keyboardOwned(groups)).toBe(false)
    expect(keyboardOwned(appReducer(groups, { type: "GROUPS_FILTER_OPEN" }))).toBe(true)
    expect(
      keyboardOwned(appReducer(groups, { type: "GROUPS_SEEK_OPEN", groupId: "billing" })),
    ).toBe(true)
  })
})
