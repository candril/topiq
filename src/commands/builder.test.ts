import { describe, expect, test } from "bun:test"
import { buildCommands } from "./builder.ts"
import { NO_FOCUS, type CommandContext, type CommandId } from "./types.ts"

// The whole point of the state-only context: state-awareness is assertable here, with no
// renderer, no client and no stubbed callbacks.

const BASE: CommandContext = {
  view: "messages",
  topic: "dg-orders",
  writeBlocked: null,
  filterQuery: "",
  follow: { active: false, paused: false, pinned: false },
  scan: null,
  showInternal: false,
  detailOpen: false,
  onlyTopic: false,
  showEphemeral: false,
  copyDestinations: 2,
  focus: NO_FOCUS,
}

function ids(ctx: Partial<CommandContext>): CommandId[] {
  return buildCommands({ ...BASE, ...ctx }).map((c) => c.id)
}

function find(ctx: Partial<CommandContext>, id: CommandId) {
  return buildCommands({ ...BASE, ...ctx }).find((c) => c.id === id)
}

describe("state awareness", () => {
  test("message commands need a focused message", () => {
    expect(ids({ focus: NO_FOCUS })).not.toContain("message.view")
    expect(ids({ focus: { ...NO_FOCUS, message: true } })).toContain("message.view")
  })

  test("replay and copy need a focused message; craft only needs the topic", () => {
    const empty = ids({ focus: NO_FOCUS })
    expect(empty).not.toContain("replay.byteExact")
    expect(empty).not.toContain("replay.edit")
    expect(empty).not.toContain("replay.copy")
    expect(empty).toContain("replay.craft")
  })

  test("no second cluster configured means no copy command", () => {
    const focus = { ...NO_FOCUS, message: true }
    expect(ids({ focus, copyDestinations: 0 })).not.toContain("replay.copy")
    expect(ids({ focus, copyDestinations: 1 })).toContain("replay.copy")
  })

  test("clear filter is offered only while a filter is applied", () => {
    expect(ids({ filterQuery: "" })).not.toContain("filter.clear")
    expect(ids({ filterQuery: "status:paid" })).toContain("filter.clear")
  })

  test("pausing the tail is offered only in follow mode", () => {
    expect(ids({})).not.toContain("fetch.followPause")
    expect(ids({ follow: { active: true, paused: false, pinned: true } })).toContain(
      "fetch.followPause",
    )
  })

  test("column commands need a column, and an envelope column cannot be hidden", () => {
    const meta = { path: "offset", header: "offset", hideable: false }
    const value = { path: "CustomerId", header: "CustomerId", hideable: true }
    expect(ids({ focus: NO_FOCUS })).not.toContain("fetch.sortColumn")
    expect(ids({ focus: { ...NO_FOCUS, column: meta } })).not.toContain("fetch.hideColumn")
    expect(ids({ focus: { ...NO_FOCUS, column: value } })).toContain("fetch.hideColumn")
  })

  test("each view offers its own surface and nothing from the others", () => {
    const topics = ids({ view: "topics", topic: null, focus: { ...NO_FOCUS, topic: "dg-orders" } })
    expect(topics).toContain("topic.open")
    expect(topics).toContain("groups.open")
    expect(topics).not.toContain("fetch.offset")
    expect(topics).not.toContain("replay.craft")

    const groups = ids({ view: "groups", focus: { ...NO_FOCUS, group: "billing" } })
    expect(groups).toContain("groups.seek")
    expect(groups).not.toContain("filter.open")

    const picker = ids({ view: "picker", topic: null })
    expect(picker).toEqual(["general.help", "general.quit"])
  })

  test("the seek command needs a group under the cursor", () => {
    expect(ids({ view: "groups", focus: NO_FOCUS })).not.toContain("groups.seek")
  })
})

describe("blocked writes stay listed with the reason (spec 019 P1)", () => {
  const blocked = "writes are disabled on core-prod — allow_write is false in the config"

  test("a gated replay is present, and carries the reason", () => {
    const focus = { ...NO_FOCUS, message: true }
    const command = find({ focus, writeBlocked: blocked }, "replay.byteExact")
    expect(command?.blocked).toBe(blocked)
  })

  test("craft and seek carry it too", () => {
    expect(find({ writeBlocked: blocked }, "replay.craft")?.blocked).toBe(blocked)
    expect(
      find(
        { view: "groups", writeBlocked: blocked, focus: { ...NO_FOCUS, group: "billing" } },
        "groups.seek",
      )?.blocked,
    ).toBe(blocked)
  })

  test("a copy is gated on the destination, so this cluster's flag does not block it", () => {
    const focus = { ...NO_FOCUS, message: true }
    expect(find({ focus, writeBlocked: blocked }, "replay.copy")?.blocked).toBeNull()
  })

  test("reads are never blocked by a write flag", () => {
    const focus = { ...NO_FOCUS, message: true }
    const reads = buildCommands({ ...BASE, focus, writeBlocked: blocked }).filter(
      (c) => c.category !== "Replay" && c.blocked !== null,
    )
    expect(reads).toEqual([])
  })
})

describe("titles and keys", () => {
  test("every command names a direct key — the palette teaches it", () => {
    const focus = { path: "CustomerId", header: "CustomerId", hideable: true }
    const everywhere = [
      buildCommands({ ...BASE, focus: { topic: null, message: true, column: focus, group: null } }),
      buildCommands({ ...BASE, view: "topics", focus: { ...NO_FOCUS, topic: "t" } }),
      buildCommands({ ...BASE, view: "groups", focus: { ...NO_FOCUS, group: "g" } }),
    ].flat()
    for (const command of everywhere) {
      expect(command.key.length).toBeGreaterThan(0)
      expect(command.title.length).toBeGreaterThan(0)
    }
  })

  test("ids are unique within a view", () => {
    const built = ids({ focus: { topic: null, message: true, column: null, group: null } })
    expect(new Set(built).size).toBe(built.length)
  })

  test("a toggle says what it will do, not what is on", () => {
    expect(find({ view: "topics", showInternal: false }, "topic.internal")?.title).toBe(
      "Show internal topics",
    )
    expect(find({ view: "topics", showInternal: true }, "topic.internal")?.title).toBe(
      "Hide internal topics",
    )
    expect(
      find({ follow: { active: true, paused: false, pinned: true } }, "fetch.follow")?.title,
    ).toBe("Stop following the tail")
  })

  test("commands that act on a named thing name it", () => {
    expect(
      find({ view: "topics", focus: { ...NO_FOCUS, topic: "dg-orders" } }, "topic.open")?.title,
    ).toBe("Open dg-orders")
    expect(
      find({ view: "groups", focus: { ...NO_FOCUS, group: "billing" } }, "groups.seek")?.title,
    ).toBe("Move billing's committed offsets")
  })
})

describe("scan (spec 030)", () => {
  test("a scan is offered once there is a filter, or while one is on screen", () => {
    expect(ids({})).not.toContain("fetch.scan")
    expect(ids({ filterQuery: "key:1" })).toContain("fetch.scan")
    const scan = { range: { kind: "beginning" } as const, query: "key:1", run: 1, stopped: false }
    expect(ids({ scan })).toContain("fetch.scan")
    expect(find({ scan }, "fetch.scan")?.title).toBe("Stop or re-run the scan")
  })

  test("leaving the hits is offered only with a scan on screen", () => {
    expect(ids({ filterQuery: "key:1" })).not.toContain("fetch.scanClose")
    const scan = { range: { kind: "beginning" } as const, query: "key:1", run: 1, stopped: true }
    expect(ids({ scan })).toContain("fetch.scanClose")
  })
})
