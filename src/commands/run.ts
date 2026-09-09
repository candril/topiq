import type { Dispatch } from "react"
import type { AppAction } from "@/state.ts"
import type { Command, CommandId, ViewActions } from "./types.ts"

// What each command does, keyed by id (spec 021). The other half of the split: the list
// describes, this runs. Most commands are a single dispatch — the ones that are not need
// the cursor row, a connection or the terminal, and those the on-screen view registers
// (see registry.ts), because only it holds them.

export interface CommandActions {
  dispatch: Dispatch<AppAction>
  /** Leaving the app is App's, not a reducer's. */
  quit: () => void
  view: ViewActions
}

/**
 * Run what the palette highlighted. A blocked command answers with its reason instead of
 * acting: it is listed precisely so the refusal is discoverable (spec 019 P1), and running
 * it must state the same thing the row does, not fail silently.
 */
export function runPaletteCommand(command: Command, actions: CommandActions): void {
  if (command.blocked !== null) {
    return actions.dispatch({
      type: "SHOW_STATUS",
      message: `${command.title.toLowerCase()}: ${command.blocked}`,
      kind: "error",
    })
  }
  runCommand(command.id, actions)
}

export function runCommand(id: CommandId, actions: CommandActions): void {
  const { dispatch, view } = actions
  // A view-backed command is only ever listed when the view registered the focus it needs,
  // so a missing callback is a wiring bug — said out loud rather than swallowed, since a
  // palette entry that does nothing is exactly what the state-awareness rule forbids.
  const run = (action: (() => void) | undefined): void => {
    if (action === undefined) {
      return dispatch({
        type: "SHOW_STATUS",
        message: `${id}: nothing here can run that`,
        kind: "error",
      })
    }
    action()
  }

  switch (id) {
    case "topic.open":
      return run(view.openTopic)
    case "topic.filter":
      return dispatch({ type: "TOPICS_FILTER_OPEN" })
    case "topic.internal":
      return dispatch({ type: "TOPICS_TOGGLE_INTERNAL" })
    case "topic.sort":
      return dispatch({ type: "TOPICS_CYCLE_SORT" })
    case "topic.detail":
      return dispatch({ type: "TOPICS_TOGGLE_DETAIL" })

    case "fetch.latestN":
      return dispatch({ type: "MSGS_PROMPT_OPEN", mode: "latestN" })
    case "fetch.offset":
      return dispatch({ type: "MSGS_PROMPT_OPEN", mode: "offset" })
    case "fetch.timestamp":
      return dispatch({ type: "MSGS_PROMPT_OPEN", mode: "timestamp" })
    case "fetch.beginning":
      return dispatch({ type: "MSGS_SET_RANGE", range: { kind: "beginning" } })
    case "fetch.reload":
      return run(view.reload)
    case "fetch.follow":
      return dispatch({ type: "MSGS_FOLLOW_TOGGLE" })
    case "fetch.followPause":
      return dispatch({ type: "MSGS_FOLLOW_PAUSE_TOGGLE" })
    case "fetch.scan":
      return run(view.scan)
    case "fetch.scanClose":
      return dispatch({ type: "MSGS_SCAN_CLOSE" })
    case "fetch.columns":
      return dispatch({ type: "MSGS_COLUMNS_OPEN" })
    case "fetch.sortColumn":
      return run(view.sortColumn)
    case "fetch.hideColumn":
      return run(view.hideColumn)

    case "filter.open":
      return dispatch({ type: "MSGS_FILTER_OPEN" })
    case "filter.js":
      return run(view.jsFilter)
    case "filter.cell":
      return run(view.filterCell)
    case "filter.clear":
      return dispatch({ type: "MSGS_FILTER_CLEAR" })

    case "message.view":
      return run(view.viewMessage)

    case "replay.byteExact":
      return run(view.replay)
    case "replay.edit":
      return run(view.editReplay)
    case "replay.craft":
      return run(view.craft)
    case "replay.copy":
      return run(view.copy)

    case "groups.open":
      return run(view.openGroups)
    case "groups.partitions":
      return dispatch({ type: "GROUPS_PANE", pane: "partitions" })
    case "groups.members":
      return dispatch({ type: "GROUPS_PANE", pane: "members" })
    case "groups.onlyTopic":
      return dispatch({ type: "GROUPS_TOGGLE_ONLY_TOPIC" })
    case "groups.ephemeral":
      return dispatch({ type: "GROUPS_TOGGLE_EPHEMERAL" })
    case "groups.sort":
      return dispatch({ type: "GROUPS_CYCLE_SORT" })
    case "groups.filter":
      return dispatch({ type: "GROUPS_FILTER_OPEN" })
    case "groups.refresh":
      return run(view.refreshGroups)
    case "groups.seek":
      return run(view.seekOffsets)
    case "groups.close":
      return dispatch({ type: "GROUPS_CLOSE" })

    case "nav.topics":
      return dispatch({ type: "SELECT_TOPIC", topic: null })
    case "nav.picker":
      return dispatch({ type: "SELECT_CLUSTER", cluster: null })

    case "general.help":
      return dispatch({ type: "OPEN_HELP" })
    case "general.quit":
      return actions.quit()
  }
}
