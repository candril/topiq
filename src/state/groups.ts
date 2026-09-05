import { GROUP_SORT_CYCLE } from "@/kafka/groups.ts"
import { SEEK_TARGETS } from "@/seek/model.ts"
import type { GroupsState, SubReducer } from "./types.ts"

// Consumer-group view state (spec 017): which topic the view describes, the cursor, the
// two visibility toggles, and the single bottom pane. Lives in the app reducer, not in the
// component, so App's global keymap can see `filterActive` and stop reading "q"/"?" as
// commands while the user is typing.

export function initialGroupsState(): GroupsState {
  return {
    topic: null,
    cursor: 0,
    filter: "",
    filterActive: false,
    // topiq's own reader groups are litter from our own consume calls (spec 009): showing
    // them by default would bury the user's consumers under our transients.
    showEphemeral: false,
    // The view is opened from a topic, so "groups of this topic" is the question asked.
    onlyTopic: true,
    sort: "name",
    pane: "none",
    paneOffset: 0,
    seek: null,
    seekTyped: "",
  }
}

function clamp(cursor: number, rowCount: number): number {
  return Math.max(0, Math.min(cursor, rowCount - 1))
}

export const groupsReducer: SubReducer = (state, action) => {
  const g = state.groups
  // The pane describes the group under the cursor, so anything that moves the cursor — or
  // reshuffles the rows beneath it — rewinds the pane's scroll.
  switch (action.type) {
    case "GROUPS_CONFIRM_TYPED":
      return g.seek?.pending === undefined || g.seek.pending === null
        ? null
        : { ...state, groups: { ...g, seekTyped: action.typed } }
    case "GROUPS_OPEN":
      return { ...state, groups: { ...initialGroupsState(), topic: action.topic } }
    case "GROUPS_CLOSE":
      // The seek bar goes with the view: a pending write left behind would reopen its
      // dialog over whatever the next view is.
      return { ...state, groups: { ...g, topic: null, filterActive: false, seek: null } }
    case "GROUPS_MOVE":
      return {
        ...state,
        groups: { ...g, cursor: clamp(g.cursor + action.delta, action.rowCount), paneOffset: 0 },
      }
    case "GROUPS_JUMP":
      return {
        ...state,
        groups: {
          ...g,
          cursor: action.to === "top" ? 0 : clamp(action.rowCount - 1, action.rowCount),
          paneOffset: 0,
        },
      }
    case "GROUPS_FILTER_OPEN":
      return { ...state, groups: { ...g, filterActive: true } }
    case "GROUPS_FILTER_CLOSE":
      return { ...state, groups: { ...g, filterActive: false } }
    case "GROUPS_FILTER_CLEAR":
      return {
        ...state,
        groups: { ...g, filter: "", filterActive: false, cursor: 0, paneOffset: 0 },
      }
    case "GROUPS_FILTER_SET":
      // Narrowing invalidates the cursor position — snap to the top of the new result.
      return { ...state, groups: { ...g, filter: action.query, cursor: 0, paneOffset: 0 } }
    case "GROUPS_TOGGLE_EPHEMERAL":
      return {
        ...state,
        groups: { ...g, showEphemeral: !g.showEphemeral, cursor: 0, paneOffset: 0 },
      }
    case "GROUPS_TOGGLE_ONLY_TOPIC":
      return { ...state, groups: { ...g, onlyTopic: !g.onlyTopic, cursor: 0, paneOffset: 0 } }
    case "GROUPS_CYCLE_SORT": {
      const next =
        GROUP_SORT_CYCLE[(GROUP_SORT_CYCLE.indexOf(g.sort) + 1) % GROUP_SORT_CYCLE.length]!
      return { ...state, groups: { ...g, sort: next, cursor: 0, paneOffset: 0 } }
    }
    case "GROUPS_PANE":
      return {
        ...state,
        groups: {
          ...g,
          pane: g.pane === action.pane ? "none" : action.pane,
          paneOffset: 0,
        },
      }
    case "GROUPS_PANE_SCROLL":
      return {
        ...state,
        groups: {
          ...g,
          paneOffset: Math.max(0, Math.min(g.paneOffset + action.delta, action.maxOffset)),
        },
      }
    case "GROUPS_SEEK_OPEN":
      return {
        ...state,
        groups: {
          ...g,
          seek: { groupId: action.groupId, choice: 0, value: null, planning: false, pending: null },
        },
      }
    case "GROUPS_SEEK_MOVE":
      if (g.seek === null) {
        return state
      }
      return {
        ...state,
        groups: {
          ...g,
          seek: {
            ...g.seek,
            choice: Math.max(0, Math.min(g.seek.choice + action.delta, SEEK_TARGETS.length - 1)),
          },
        },
      }
    case "GROUPS_SEEK_TYPE":
      if (g.seek === null) {
        return state
      }
      return { ...state, groups: { ...g, seek: { ...g.seek, value: action.value } } }
    case "GROUPS_SEEK_PLANNING":
      if (g.seek === null) {
        return state
      }
      return { ...state, groups: { ...g, seek: { ...g.seek, planning: true } } }
    case "GROUPS_SEEK_PLANNED":
      // A plan that outlived its bar is dropped rather than shown: opening a write dialog
      // for a seek the user cancelled would be a dialog nobody asked for.
      if (g.seek === null || g.seek.groupId !== action.groupId) {
        return state
      }
      return {
        ...state,
        groups: { ...g, seek: { ...g.seek, planning: false, pending: action.pending } },
      }
    case "GROUPS_SEEK_CANCEL":
      return { ...state, groups: { ...g, seek: null } }
    default:
      return null
  }
}
