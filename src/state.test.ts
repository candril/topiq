import { describe, expect, test } from "bun:test"
import { appReducer, createInitialState } from "./state.ts"

describe("appReducer router", () => {
  test("SELECT_CLUSTER sets the cluster and drops the topic", () => {
    const state = createInitialState({ cluster: "test", topic: "orders" })
    const next = appReducer(state, { type: "SELECT_CLUSTER", cluster: "prod" })
    expect(next.cluster).toBe("prod")
    expect(next.topic).toBeNull()
  })

  test("SELECT_TOPIC keeps the cluster", () => {
    const state = createInitialState({ cluster: "test" })
    const next = appReducer(state, { type: "SELECT_TOPIC", topic: "orders" })
    expect(next).toMatchObject({ cluster: "test", topic: "orders" })
  })

  test("help open/close round-trips without touching the session slice", () => {
    const state = createInitialState({ cluster: "test", topic: "orders" })
    const opened = appReducer(state, { type: "OPEN_HELP" })
    expect(opened.helpOpen).toBe(true)
    const closed = appReducer(opened, { type: "CLOSE_HELP" })
    expect(closed).toEqual(state)
  })

  test("SHOW_STATUS defaults to info and CLEAR_STATUS removes it", () => {
    const shown = appReducer(createInitialState(), { type: "SHOW_STATUS", message: "produced 3" })
    expect(shown.status).toEqual({ message: "produced 3", kind: "info" })
    expect(appReducer(shown, { type: "CLEAR_STATUS" }).status).toBeNull()
  })

  test("an unclaimed action returns the same state reference", () => {
    const state = createInitialState()
    // Cast: simulates an action no sub-reducer claims, which the router must pass through.
    const next = appReducer(state, { type: "NOPE" } as never)
    expect(next).toBe(state)
  })
})
