import { initialGroupsState } from "./groups.ts"
import { initialMessagesState } from "./messages.ts"
import { initialTopicListState } from "./topicList.ts"
import type { SubReducer } from "./types.ts"

// What the header shows: which cluster, which topic, which fetch mode (spec 001).

export const sessionReducer: SubReducer = (state, action) => {
  switch (action.type) {
    case "SELECT_CLUSTER":
      // Topics, filter and sort are cluster-local: a stale namespace filter would
      // silently hide the next cluster's topics (spec 023).
      return {
        ...state,
        cluster: action.cluster,
        topic: null,
        topics: initialTopicListState(),
        // Group ids and lag are cluster-local too (spec 017).
        groups: initialGroupsState(),
      }
    case "SELECT_TOPIC":
      // Cursor, range and prompt are window-local: carrying them across topics would aim
      // an old offset range at a topic with different watermarks (spec 009).
      return {
        ...state,
        topic: action.topic,
        messages: initialMessagesState(),
        // Opening a topic leaves the group view: its lag figures describe another topic.
        groups: initialGroupsState(),
      }
    case "SET_MODE":
      return { ...state, mode: action.mode }
    default:
      return null
  }
}
