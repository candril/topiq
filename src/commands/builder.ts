import type { Command, CommandCategory, CommandContext, CommandId } from "./types.ts"

// The state-aware command list (spec 021 P1). Pure over `CommandContext`: no callbacks, no
// client, no renderer — so "is this command offered right now?" is a unit test.
//
// The rule this file exists to keep: a command that cannot act is *absent*, so enter can
// never land on a no-op. The single exception is a write the gate blocks — it stays listed
// with its reason, because an absent replay reads as "topiq cannot replay" (spec 019 P1).

function command(
  id: CommandId,
  category: CommandCategory,
  title: string,
  key: string,
  blocked: string | null = null,
): Command {
  return { id, category, title, key, blocked }
}

export function buildCommands(ctx: CommandContext): Command[] {
  return [
    ...topicCommands(ctx),
    ...fetchCommands(ctx),
    ...filterCommands(ctx),
    ...messageCommands(ctx),
    ...replayCommands(ctx),
    ...groupCommands(ctx),
    ...navCommands(ctx),
    ...generalCommands(ctx),
  ]
}

function topicCommands(ctx: CommandContext): Command[] {
  if (ctx.view !== "topics") {
    return []
  }
  const out: Command[] = []
  if (ctx.focus.topic !== null) {
    out.push(command("topic.open", "Topic", `Open ${ctx.focus.topic}`, "enter"))
  }
  out.push(
    command("topic.filter", "Topic", "Filter topics", "/"),
    command(
      "topic.internal",
      "Topic",
      ctx.showInternal ? "Hide internal topics" : "Show internal topics",
      "i",
    ),
    command("topic.sort", "Topic", "Cycle topic sort", "s"),
    command(
      "topic.detail",
      "Topic",
      ctx.detailOpen ? "Hide partition detail" : "Partition detail",
      "p",
    ),
  )
  return out
}

function fetchCommands(ctx: CommandContext): Command[] {
  if (ctx.view !== "messages") {
    return []
  }
  const out: Command[] = [
    command("fetch.latestN", "Fetch", "Fetch the latest N", "n"),
    command("fetch.offset", "Fetch", "Fetch from an offset", "o"),
    command("fetch.timestamp", "Fetch", "Fetch from a timestamp", "t"),
    command("fetch.beginning", "Fetch", "Fetch from the beginning", "b"),
    command("fetch.reload", "Fetch", "Reload the window", "r"),
    command(
      "fetch.follow",
      "Fetch",
      ctx.follow.active ? "Stop following the tail" : "Follow the tail",
      "f",
    ),
  ]
  // Pausing means nothing with no tail running, so it is not offered then (spec 012).
  if (ctx.follow.active) {
    out.push(
      command(
        "fetch.followPause",
        "Fetch",
        ctx.follow.paused ? "Resume the tail" : "Pause the tail",
        "space",
      ),
    )
  }
  out.push(command("fetch.columns", "Fetch", "Choose columns", "c"))
  const column = ctx.focus.column
  if (column !== null) {
    out.push(command("fetch.sortColumn", "Fetch", `Sort by ${column.header}`, "s"))
    if (column.hideable) {
      out.push(command("fetch.hideColumn", "Fetch", `Hide ${column.header}`, "-"))
    }
  }
  return out
}

function filterCommands(ctx: CommandContext): Command[] {
  if (ctx.view !== "messages") {
    return []
  }
  const out: Command[] = [
    command("filter.open", "Filter", "Filter the window", "/"),
    command("filter.js", "Filter", "JS predicate filter", "="),
  ]
  if (ctx.focus.message && ctx.focus.column !== null) {
    out.push(command("filter.cell", "Filter", `Filter by the ${ctx.focus.column.header} cell`, "*"))
  }
  if (ctx.filterQuery !== "") {
    out.push(command("filter.clear", "Filter", "Clear the filter", "esc"))
  }
  return out
}

function messageCommands(ctx: CommandContext): Command[] {
  if (ctx.view !== "messages" || !ctx.focus.message) {
    return []
  }
  return [command("message.view", "Message", "View this message in $EDITOR", "enter")]
}

function replayCommands(ctx: CommandContext): Command[] {
  if (ctx.view !== "messages") {
    return []
  }
  const out: Command[] = []
  if (ctx.focus.message) {
    out.push(
      command(
        "replay.byteExact",
        "Replay",
        "Replay this message byte-exact",
        "p",
        ctx.writeBlocked,
      ),
      command("replay.edit", "Replay", "Edit in $EDITOR, then replay", "e", ctx.writeBlocked),
    )
  }
  if (ctx.topic !== null) {
    out.push(
      command(
        "replay.craft",
        "Replay",
        "New message from the latest schema",
        "shift+N",
        ctx.writeBlocked,
      ),
    )
  }
  // A copy is gated on the *destination*, not on this cluster (spec 016), so the connected
  // cluster's allow_write says nothing here — the destination list labels the read-only
  // ones and the gate refuses at plan time.
  if (ctx.focus.message && ctx.copyDestinations > 0) {
    out.push(command("replay.copy", "Replay", "Copy this message to another cluster", "y"))
  }
  return out
}

function groupCommands(ctx: CommandContext): Command[] {
  if (ctx.view === "topics" && ctx.focus.topic !== null) {
    // Lag is per topic, so the group view is opened *from* a topic row (spec 017).
    return [command("groups.open", "Groups", `Consumer groups for ${ctx.focus.topic}`, "c")]
  }
  if (ctx.view !== "groups") {
    return []
  }
  const out: Command[] = [
    command("groups.partitions", "Groups", "Per-partition committed, high and lag", "p"),
    command("groups.members", "Groups", "Group members", "m"),
    command(
      "groups.onlyTopic",
      "Groups",
      ctx.onlyTopic ? "All groups on the cluster" : "Only groups consuming this topic",
      "t",
    ),
    command(
      "groups.ephemeral",
      "Groups",
      ctx.showEphemeral ? "Hide topiq's reader groups" : "Show topiq's reader groups",
      "e",
    ),
    command("groups.sort", "Groups", "Cycle group sort", "s"),
    command("groups.filter", "Groups", "Filter by group id", "/"),
    command("groups.refresh", "Groups", "Refresh state and lag", "r"),
  ]
  if (ctx.focus.group !== null) {
    out.push(
      command(
        "groups.seek",
        "Groups",
        `Move ${ctx.focus.group}'s committed offsets`,
        "o",
        ctx.writeBlocked,
      ),
    )
  }
  out.push(command("groups.close", "Groups", "Close the group view", "h"))
  return out
}

function navCommands(ctx: CommandContext): Command[] {
  switch (ctx.view) {
    case "messages":
      return [command("nav.topics", "General", "Back to the topic list", "esc")]
    case "topics":
      return [command("nav.picker", "General", "Back to the cluster picker", "h")]
    default:
      return []
  }
}

function generalCommands(_ctx: CommandContext): Command[] {
  return [
    command("general.help", "General", "Keyboard help", "?"),
    command("general.quit", "General", "Quit topiq", "q"),
  ]
}
