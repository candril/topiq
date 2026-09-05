import { SORT_CYCLE } from "@/views/topicListModel.ts"
import type { SubReducer, TopicListState } from "./types.ts"

// Topic-list UI state (spec 006): incremental filter, internal toggle, sort, cursor.
// Lives in the app reducer (not component state) so App's global keymap can see
// filterActive and stop treating "q"/"?" as commands while the user is typing.

export function initialTopicListState(): TopicListState {
  return {
    filter: "",
    filterActive: false,
    showInternal: false,
    sort: "name",
    cursor: 0,
    detailOpen: false,
    detailOffset: 0,
  }
}

function clamp(cursor: number, rowCount: number): number {
  return Math.max(0, Math.min(cursor, rowCount - 1))
}

export const topicListReducer: SubReducer = (state, action) => {
  const t = state.topics
  // The detail pane belongs to whichever topic is under the cursor, so anything that
  // moves the cursor — or reshuffles the rows beneath it — rewinds its scroll.
  switch (action.type) {
    case "TOPICS_FILTER_OPEN":
      return { ...state, topics: { ...t, filterActive: true } }
    case "TOPICS_FILTER_CLOSE":
      return { ...state, topics: { ...t, filterActive: false } }
    case "TOPICS_FILTER_CLEAR":
      return {
        ...state,
        topics: { ...t, filter: "", filterActive: false, cursor: 0, detailOffset: 0 },
      }
    case "TOPICS_FILTER_APPEND":
      // Narrowing invalidates the cursor position — snap to the top of the new result.
      return {
        ...state,
        topics: { ...t, filter: t.filter + action.char, cursor: 0, detailOffset: 0 },
      }
    case "TOPICS_FILTER_SET":
      // Cursor home: the row under it belongs to the previous result set.
      return { ...state, topics: { ...t, filter: action.filter, cursor: 0 } }
    case "TOPICS_FILTER_BACKSPACE":
      return {
        ...state,
        topics: { ...t, filter: t.filter.slice(0, -1), cursor: 0, detailOffset: 0 },
      }
    case "TOPICS_TOGGLE_INTERNAL":
      return {
        ...state,
        topics: { ...t, showInternal: !t.showInternal, cursor: 0, detailOffset: 0 },
      }
    case "TOPICS_TOGGLE_DETAIL":
      return { ...state, topics: { ...t, detailOpen: !t.detailOpen, detailOffset: 0 } }
    case "TOPICS_DETAIL_SCROLL":
      return {
        ...state,
        topics: {
          ...t,
          detailOffset: Math.max(0, Math.min(t.detailOffset + action.delta, action.maxOffset)),
        },
      }
    case "TOPICS_CYCLE_SORT": {
      const next = SORT_CYCLE[(SORT_CYCLE.indexOf(t.sort) + 1) % SORT_CYCLE.length]!
      return { ...state, topics: { ...t, sort: next, detailOffset: 0 } }
    }
    case "TOPICS_MOVE":
      return {
        ...state,
        topics: {
          ...t,
          cursor: clamp(t.cursor + action.delta, action.rowCount),
          detailOffset: 0,
        },
      }
    case "TOPICS_JUMP":
      return {
        ...state,
        topics: {
          ...t,
          cursor: action.to === "top" ? 0 : clamp(action.rowCount - 1, action.rowCount),
          detailOffset: 0,
        },
      }
    default:
      return null
  }
}
