import type { SortState } from "@/table/sort.ts"
import type { GroupSort } from "@/kafka/groups.ts"
import type { FetchRange } from "@/kafka/range.ts"
import type { RawProduce } from "@/replay/produce.ts"
import type { ConfirmPrompt, WriteAction } from "@/safety/gate.ts"
import type { PendingSeek } from "@/seek/run.ts"
import type { PromptMode } from "@/table/window.ts"
import type { DecodedMessage } from "@/types.ts"
import type { TopicSort } from "@/views/topicListModel.ts"

// App-state shape and the action union (spec 001). Sub-reducers each own a slice of the
// action space and return null for actions that aren't theirs — the router in
// src/state.ts tries them in order (monq's pattern).

export type FetchMode = FetchRange["kind"]

export type StatusKind = "info" | "success" | "error"

export interface StatusMessage {
  message: string
  kind: StatusKind
}

export interface PickerState {
  /** Cursor over selectable profile rows — group headers don't count (spec 023). */
  cursor: number
}

export interface TopicListState {
  filter: string
  /** Typing mode: printable keys go into the filter instead of the keymap (spec 006). */
  filterActive: boolean
  showInternal: boolean
  sort: TopicSort
  cursor: number
  /** Bottom pane with per-partition watermarks + leader (spec 006 P2). */
  detailOpen: boolean
  /** First partition row the pane shows — it scrolls past its height (spec 006). */
  detailOffset: number
}

/** One pane below the group list at a time, so `J`/`K` never has two things to scroll. */
export type GroupPane = "none" | "partitions" | "members"

/** The offset-seek bar and its dialog (spec 018). Non-null while it owns the keyboard —
 *  App stands down completely so `q` cannot quit out from under a pending write. */
export interface GroupSeekState {
  /** The group the bar was opened on. The cursor may move; the seek does not follow it. */
  groupId: string
  /** Cursor over `SEEK_TARGETS`. */
  choice: number
  /** Typed value for a target that needs one; null while choosing a target. */
  value: string | null
  /** The broker round trip behind the preview is in flight. */
  planning: boolean
  /** Resolved plan waiting on its confirm keystroke; the dialog is open while non-null. */
  pending: PendingSeek | null
}

export interface GroupsState {
  /** The topic the view describes; null means the view is closed. Lag is per topic, so
   *  there is no group list without one (spec 017). */
  topic: string | null
  cursor: number
  filter: string
  /** Typing mode: the keymap stands down while the <input> owns the keyboard. */
  filterActive: boolean
  /** Reveal topiq's own `topiq-read-*` reader groups — hidden by default (spec 017). */
  showEphemeral: boolean
  /** Restrict to groups that consume `topic` (spec 017 P2). */
  onlyTopic: boolean
  sort: GroupSort
  pane: GroupPane
  /** First row the open pane shows — it scrolls past its height. */
  paneOffset: number
  /** Offset seek in progress (spec 018); null when the bar is closed. */
  seek: GroupSeekState | null
  /** Retyped confirmation text for a prod target (spec 016/019). */
  seekTyped: string
}

export interface MessageFilterState {
  /** The expression as typed (spec 010). A leading `=` makes the rest a JS predicate
   *  (spec 011) — one string, so no mode flag can drift from the text it applies to. */
  query: string
  /** Typing mode: printable keys go into the filter instead of the keymap. */
  active: boolean
}

export interface MessageFollowState {
  /** Follow mode: a tail consumer appends to the window (spec 012). */
  active: boolean
  /** Paused means "stop appending" — the consumer stays connected and keeps buffering. */
  paused: boolean
  /** The cursor rides the newest row until it is moved off the bottom; `G` re-pins it. */
  pinned: boolean
}

/** A write waiting on its confirm keystroke (spec 019). The bytes are already decided:
 *  `produce` is built when the dialog opens, so confirming can only send what the dialog
 *  described — there is no second chance for a decoded payload to get in (spec 013). */
export interface PendingWrite {
  prompt: ConfirmPrompt
  /** The same action the prompt was built from, re-checked at the moment of the write. */
  action: WriteAction
  produce: RawProduce
  /** Profile name of the cluster these bytes are aimed at. A cross-cluster copy targets a
   *  *different* cluster from the connected one (spec 016), so the write resolves its client
   *  by this name and refuses when it does not hold that connection: the dialog names one
   *  cluster, and the produce goes to that one or to none. */
  cluster: string
}

/** The cross-cluster copy bar (spec 016). Non-null while it owns the keyboard — App stands
 *  down completely, as it does for a seek, so `q` cannot quit out from under a pending copy. */
export interface CopyState {
  /** The message the copy was opened on. The cursor may move (a tail keeps arriving); the
   *  copy does not follow it — same rule as the seek bar's group (spec 018). */
  row: DecodedMessage
  /** Cursor over the candidate destination profiles, ordered by `copyDestinations`. */
  choice: number
  /** Destination topic, once a profile is picked; null while still choosing the profile. */
  topic: string | null
  /** The connect + two-registry round trip behind the dialog is in flight. */
  planning: boolean
}

export interface MessagesState {
  cursor: number
  /** The active window descriptor (spec 009) — consume re-runs when it changes. */
  range: FetchRange
  /** Range-input prompt: while non-null, printable keys type here, not the keymap. */
  prompt: { mode: PromptMode; input: string } | null
  /** Local predicate over the loaded window (spec 010) — never a re-fetch. */
  filter: MessageFilterState
  /** Multi-line JS predicate editor (spec 011); non-null while it owns the keyboard. */
  jsEditor: string | null
  follow: MessageFollowState
  /** Index into the *visible* column set (spec 024); the view clamps it as inference
   *  changes the columns. */
  column: number
  /** Value-column paths the user hid. Inference still finds them; they are not drawn. */
  hiddenColumns: readonly string[]
  /** Field picker overlay: non-null while it owns the keyboard, holding its cursor. */
  columnPicker: number | null
  sort: SortState
  /** Write confirmation modal (spec 019): non-null while it owns the keyboard. */
  confirm: PendingWrite | null
  /** Retyped confirmation text for a prod target (spec 016/019). */
  confirmTyped: string
  /** Cross-cluster copy in progress (spec 016); null when the bar is closed. */
  copy: CopyState | null
}

/** The command palette (spec 021): non-null while it owns the keyboard, holding the query
 *  as typed and the highlight over the *matching* commands. */
export interface PaletteState {
  query: string
  cursor: number
}

export interface AppState {
  cluster: string | null
  topic: string | null
  mode: FetchMode
  helpOpen: boolean
  /** Non-null while the palette is open — every other view stands down (spec 021). */
  palette: PaletteState | null
  picker: PickerState
  topics: TopicListState
  groups: GroupsState
  messages: MessagesState
  /** Transient status line (spec 001 P2): rendered only while non-null. */
  status: StatusMessage | null
}

export type AppAction =
  | { type: "SELECT_CLUSTER"; cluster: string | null }
  | { type: "SELECT_TOPIC"; topic: string | null }
  | { type: "SET_MODE"; mode: FetchMode }
  | { type: "OPEN_HELP" }
  | { type: "CLOSE_HELP" }
  | { type: "PALETTE_OPEN" }
  | { type: "PALETTE_CLOSE" }
  | { type: "PALETTE_SET"; query: string }
  /** rowCount is the number of *matching* commands, which only the view can count. */
  | { type: "PALETTE_MOVE"; delta: number; rowCount: number }
  | { type: "SHOW_STATUS"; message: string; kind?: StatusKind }
  | { type: "CLEAR_STATUS" }
  | { type: "PICKER_MOVE"; delta: number; rowCount: number }
  | { type: "PICKER_JUMP"; to: "top" | "bottom"; rowCount: number }
  | { type: "TOPICS_FILTER_OPEN" }
  | { type: "TOPICS_FILTER_CLOSE" }
  | { type: "TOPICS_FILTER_CLEAR" }
  | { type: "TOPICS_FILTER_APPEND"; char: string }
  | { type: "TOPICS_FILTER_BACKSPACE" }
  | { type: "TOPICS_FILTER_SET"; filter: string }
  | { type: "TOPICS_TOGGLE_INTERNAL" }
  | { type: "TOPICS_TOGGLE_DETAIL" }
  | { type: "TOPICS_DETAIL_SCROLL"; delta: number; maxOffset: number }
  | { type: "TOPICS_CYCLE_SORT" }
  // Cursor moves carry rowCount because visible rows are derived in the view — the
  // reducer alone cannot clamp.
  | { type: "TOPICS_MOVE"; delta: number; rowCount: number }
  | { type: "TOPICS_JUMP"; to: "top" | "bottom"; rowCount: number }
  | { type: "GROUPS_OPEN"; topic: string }
  | { type: "GROUPS_CLOSE" }
  | { type: "GROUPS_MOVE"; delta: number; rowCount: number }
  | { type: "GROUPS_JUMP"; to: "top" | "bottom"; rowCount: number }
  | { type: "GROUPS_FILTER_OPEN" }
  | { type: "GROUPS_FILTER_CLOSE" }
  | { type: "GROUPS_FILTER_CLEAR" }
  | { type: "GROUPS_FILTER_SET"; query: string }
  | { type: "GROUPS_TOGGLE_EPHEMERAL" }
  | { type: "GROUPS_TOGGLE_ONLY_TOPIC" }
  | { type: "GROUPS_CYCLE_SORT" }
  /** Toggling: asking for the pane that is already open closes it. */
  | { type: "GROUPS_PANE"; pane: Exclude<GroupPane, "none"> }
  | { type: "GROUPS_PANE_SCROLL"; delta: number; maxOffset: number }
  | { type: "GROUPS_SEEK_OPEN"; groupId: string }
  | { type: "GROUPS_SEEK_MOVE"; delta: number }
  /** Switch to typing a value for the chosen target (offset/timestamp). */
  | { type: "GROUPS_SEEK_TYPE"; value: string }
  | { type: "GROUPS_SEEK_PLANNING" }
  /** The resolved plan. Carries `groupId` so a plan for a seek that was cancelled — or
   *  reopened on another group — cannot open a dialog for the wrong group. */
  | { type: "GROUPS_SEEK_PLANNED"; groupId: string; pending: PendingSeek }
  | { type: "GROUPS_SEEK_CANCEL" }
  | { type: "MSGS_MOVE"; delta: number; rowCount: number }
  | { type: "MSGS_JUMP"; to: "top" | "bottom"; rowCount: number }
  | { type: "MSGS_PROMPT_OPEN"; mode: PromptMode }
  | { type: "MSGS_PROMPT_APPEND"; char: string }
  | { type: "MSGS_PROMPT_BACKSPACE" }
  | { type: "MSGS_PROMPT_CANCEL" }
  | { type: "MSGS_SET_RANGE"; range: FetchRange }
  | { type: "MSGS_COLUMN_MOVE"; delta: number; columnCount: number }
  | { type: "MSGS_COLUMN_JUMP"; to: "first" | "last"; columnCount: number }
  | { type: "MSGS_SORT_CYCLE"; path: string }
  | { type: "MSGS_COLUMN_HIDE"; path: string }
  | { type: "MSGS_COLUMNS_OPEN" }
  | { type: "MSGS_COLUMNS_CLOSE" }
  | { type: "MSGS_COLUMNS_MOVE"; delta: number; rowCount: number }
  | { type: "MSGS_COLUMNS_TOGGLE"; path: string }
  | { type: "MSGS_COLUMNS_RESET" }
  | { type: "MSGS_FILTER_OPEN" }
  | { type: "MSGS_FILTER_CLOSE" }
  | { type: "MSGS_FILTER_CLEAR" }
  | { type: "MSGS_FILTER_APPEND"; char: string }
  | { type: "MSGS_FILTER_BACKSPACE" }
  | { type: "MSGS_PROMPT_SET"; input: string }
  | { type: "MSGS_FILTER_SET"; query: string }
  | { type: "MSGS_JS_OPEN"; source: string }
  | { type: "MSGS_JS_SET"; source: string }
  | { type: "MSGS_JS_CANCEL" }
  | { type: "MSGS_JS_APPLY" }
  | { type: "MSGS_FOLLOW_TOGGLE" }
  | { type: "MSGS_FOLLOW_PAUSE_TOGGLE" }
  | { type: "MSGS_CONFIRM_OPEN"; pending: PendingWrite }
  | { type: "MSGS_CONFIRM_CLOSE" }
  | { type: "MSGS_CONFIRM_TYPED"; typed: string }
  | { type: "GROUPS_CONFIRM_TYPED"; typed: string }
  | { type: "MSGS_COPY_OPEN"; row: DecodedMessage }
  | { type: "MSGS_COPY_MOVE"; delta: number; rowCount: number }
  /** Profile chosen: the bar switches to the destination topic, pre-filled with the
   *  prefix-mapped name (spec 023). */
  | { type: "MSGS_COPY_TOPIC"; topic: string }
  | { type: "MSGS_COPY_PLANNING" }
  | { type: "MSGS_COPY_CLOSE" }

/** null = not my action, let the router try the next sub-reducer. */
export type SubReducer = (state: AppState, action: AppAction) => AppState | null
