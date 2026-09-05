import { groupsReducer, initialGroupsState } from "./state/groups.ts"
import { initialMessagesState, messagesReducer } from "./state/messages.ts"
import { paletteReducer } from "./state/palette.ts"
import { initialPickerState, pickerReducer } from "./state/picker.ts"
import { sessionReducer } from "./state/session.ts"
import { initialTopicListState, topicListReducer } from "./state/topicList.ts"
import { uiReducer } from "./state/ui.ts"
import type { AppAction, AppState } from "./state/types.ts"

// The reducer router (spec 001): a single useReducer owns app state; domain sub-reducers
// under src/state/ each claim their actions and return null otherwise.

export type {
  AppAction,
  AppState,
  CopyState,
  FetchMode,
  GroupPane,
  GroupSeekState,
  GroupsState,
  MessageFilterState,
  MessageFollowState,
  MessagesState,
  PaletteState,
  PendingWrite,
  PickerState,
  StatusKind,
  StatusMessage,
  TopicListState,
} from "./state/types.ts"

export function createInitialState(overrides: Partial<AppState> = {}): AppState {
  return {
    cluster: null,
    topic: null,
    // "latest N" is the default window (spec 009): newest data is what a peek wants.
    mode: "latestN",
    helpOpen: false,
    palette: null,
    picker: initialPickerState(),
    topics: initialTopicListState(),
    groups: initialGroupsState(),
    messages: initialMessagesState(),
    status: null,
    ...overrides,
  }
}

const reducers = [
  sessionReducer,
  uiReducer,
  paletteReducer,
  pickerReducer,
  topicListReducer,
  groupsReducer,
  messagesReducer,
]

export function appReducer(state: AppState, action: AppAction): AppState {
  for (const reducer of reducers) {
    const next = reducer(state, action)
    if (next !== null) {
      return next
    }
  }
  return state
}
