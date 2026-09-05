import { describe, expect, test } from "bun:test"
import { appReducer, createInitialState } from "@/state.ts"
import type { AppAction, AppState } from "@/state.ts"

function apply(state: AppState, ...actions: AppAction[]): AppState {
  return actions.reduce(appReducer, state)
}

const opened = apply(createInitialState({ cluster: "test" }), {
  type: "GROUPS_OPEN",
  topic: "orders",
})

describe("groupsReducer", () => {
  test("opening names the topic and starts scoped to it", () => {
    expect(opened.groups.topic).toBe("orders")
    expect(opened.groups.onlyTopic).toBe(true)
    expect(opened.groups.showEphemeral).toBe(false)
  })

  test("reopening on another topic resets the view rather than carrying lag context over", () => {
    const dirty = apply(
      opened,
      { type: "GROUPS_FILTER_SET", query: "orders-" },
      { type: "GROUPS_TOGGLE_EPHEMERAL" },
      { type: "GROUPS_MOVE", delta: 3, rowCount: 10 },
    )
    const reopened = apply(dirty, { type: "GROUPS_OPEN", topic: "invoices" })
    expect(reopened.groups).toMatchObject({
      topic: "invoices",
      filter: "",
      showEphemeral: false,
      cursor: 0,
    })
  })

  test("the cursor clamps to the row count", () => {
    expect(apply(opened, { type: "GROUPS_MOVE", delta: 99, rowCount: 4 }).groups.cursor).toBe(3)
    expect(apply(opened, { type: "GROUPS_MOVE", delta: -5, rowCount: 4 }).groups.cursor).toBe(0)
    expect(apply(opened, { type: "GROUPS_JUMP", to: "bottom", rowCount: 0 }).groups.cursor).toBe(0)
  })

  test("moving the cursor rewinds the pane, which describes the cursor group", () => {
    const scrolled = apply(
      opened,
      { type: "GROUPS_PANE", pane: "partitions" },
      { type: "GROUPS_PANE_SCROLL", delta: 4, maxOffset: 10 },
    )
    expect(scrolled.groups.paneOffset).toBe(4)
    expect(apply(scrolled, { type: "GROUPS_MOVE", delta: 1, rowCount: 5 }).groups.paneOffset).toBe(
      0,
    )
  })

  test("pane scroll is clamped to the pane's own maximum", () => {
    const state = apply(
      opened,
      { type: "GROUPS_PANE", pane: "members" },
      { type: "GROUPS_PANE_SCROLL", delta: 9, maxOffset: 2 },
    )
    expect(state.groups.paneOffset).toBe(2)
    expect(
      apply(state, { type: "GROUPS_PANE_SCROLL", delta: -9, maxOffset: 2 }).groups.paneOffset,
    ).toBe(0)
  })

  test("asking for the open pane closes it; asking for the other one switches", () => {
    const partitions = apply(opened, { type: "GROUPS_PANE", pane: "partitions" })
    expect(partitions.groups.pane).toBe("partitions")
    expect(apply(partitions, { type: "GROUPS_PANE", pane: "partitions" }).groups.pane).toBe("none")
    expect(apply(partitions, { type: "GROUPS_PANE", pane: "members" }).groups.pane).toBe("members")
  })

  test("narrowing the filter snaps the cursor back to the top", () => {
    const moved = apply(opened, { type: "GROUPS_MOVE", delta: 5, rowCount: 20 })
    expect(apply(moved, { type: "GROUPS_FILTER_SET", query: "a" }).groups.cursor).toBe(0)
  })

  test("the sort cycle returns to where it started", () => {
    const cycle = (n: number) =>
      apply(opened, ...Array.from({ length: n }, () => ({ type: "GROUPS_CYCLE_SORT" }) as const))
    expect(cycle(1).groups.sort).toBe("lag")
    expect(cycle(2).groups.sort).toBe("state")
    expect(cycle(3).groups.sort).toBe("name")
  })

  test("opening a topic closes the group view — its lag describes another topic", () => {
    const state = apply(opened, { type: "SELECT_TOPIC", topic: "orders" })
    expect(state.groups.topic).toBeNull()
    expect(state.topic).toBe("orders")
  })

  test("switching cluster closes it too — group ids are cluster-local", () => {
    expect(apply(opened, { type: "SELECT_CLUSTER", cluster: null }).groups.topic).toBeNull()
  })
})

describe("offset seek (spec 018)", () => {
  const seeking = apply(opened, { type: "GROUPS_SEEK_OPEN", groupId: "orders-projector" })

  const pending = {
    prompt: {
      kind: "seek" as const,
      title: "Seek orders-projector to beginning",
      lines: [],
      warnings: [],
      confirmKey: "S",
      hint: "",
      prod: false,
      typeToConfirm: null,
    },
    action: {
      kind: "seek" as const,
      group: "orders-projector",
      topic: "orders",
      count: 2,
      to: "beginning",
      moves: [],
    },
    plan: {
      groupId: "orders-projector",
      topic: "orders",
      range: { kind: "beginning" as const },
      rows: [],
    },
  }

  test("the bar names the group it was opened on, not the cursor", () => {
    // The cursor may move under a refresh; the seek must not follow it onto another group.
    const moved = apply(seeking, { type: "GROUPS_MOVE", delta: 3, rowCount: 10 })
    expect(moved.groups.seek?.groupId).toBe("orders-projector")
  })

  test("the target cursor clamps to the available targets", () => {
    expect(apply(seeking, { type: "GROUPS_SEEK_MOVE", delta: 99 }).groups.seek?.choice).toBe(3)
    expect(apply(seeking, { type: "GROUPS_SEEK_MOVE", delta: -1 }).groups.seek?.choice).toBe(0)
  })

  test("a plan for a cancelled seek opens no dialog", () => {
    const cancelled = apply(seeking, { type: "GROUPS_SEEK_CANCEL" })
    const late = apply(cancelled, {
      type: "GROUPS_SEEK_PLANNED",
      groupId: "orders-projector",
      pending,
    })
    expect(late.groups.seek).toBeNull()
  })

  test("a plan for another group opens no dialog either", () => {
    const other = apply(seeking, {
      type: "GROUPS_SEEK_PLANNED",
      groupId: "invoice-projector",
      pending,
    })
    expect(other.groups.seek?.pending).toBeNull()
  })

  test("the plan arriving clears the in-flight flag and opens the dialog", () => {
    const planned = apply(
      seeking,
      { type: "GROUPS_SEEK_PLANNING" },
      { type: "GROUPS_SEEK_PLANNED", groupId: "orders-projector", pending },
    )
    expect(planned.groups.seek?.planning).toBe(false)
    expect(planned.groups.seek?.pending?.prompt.confirmKey).toBe("S")
  })

  test("leaving the view drops a pending write rather than carrying its dialog out", () => {
    const planned = apply(seeking, {
      type: "GROUPS_SEEK_PLANNED",
      groupId: "orders-projector",
      pending,
    })
    expect(apply(planned, { type: "GROUPS_CLOSE" }).groups.seek).toBeNull()
  })
})
