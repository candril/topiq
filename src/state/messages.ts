import { JS_PREFIX } from "@/views/filterBarModel.ts"
import { cycleSort, UNSORTED } from "@/table/sort.ts"
import type { MessageFollowState, MessagesState, SubReducer } from "./types.ts"

// Message-window UI state (specs 007/009/012): cursor plus the active fetch range, the
// range-input prompt, the filter and the follow toggle. In the app reducer (not component
// state) so App's global keymap can see the prompt capturing text and stop treating
// "q"/"?" as commands.

const NOT_FOLLOWING: MessageFollowState = { active: false, paused: false, pinned: false }

export function initialMessagesState(): MessagesState {
  return {
    cursor: 0,
    // Newest data is what a peek wants (spec 009): latest 50 is the default window.
    range: { kind: "latestN", n: 50 },
    prompt: null,
    jsEditor: null,
    column: 0,
    hiddenColumns: [],
    columnPicker: null,
    sort: UNSORTED,
    filter: { query: "", active: false },
    follow: NOT_FOLLOWING,
    confirm: null,
    confirmTyped: "",
    copy: null,
  }
}

function clamp(cursor: number, rowCount: number): number {
  return Math.max(0, Math.min(cursor, rowCount - 1))
}

/** While pinned the cursor is wherever the newest row is, not where it was last stored —
 *  a relative move has to start from there or the first `k` jumps to a stale position. */
function effectiveCursor(m: MessagesState, rowCount: number): number {
  return m.follow.pinned ? rowCount - 1 : m.cursor
}

export const messagesReducer: SubReducer = (state, action) => {
  const m = state.messages
  switch (action.type) {
    case "MSGS_MOVE": {
      const cursor = clamp(effectiveCursor(m, action.rowCount) + action.delta, action.rowCount)
      return {
        ...state,
        messages: {
          ...m,
          cursor,
          // Still on the newest row: the user pressed down at the bottom, which is what
          // following already does — only moving off the end takes the wheel (spec 012).
          follow: { ...m.follow, pinned: m.follow.pinned && cursor === action.rowCount - 1 },
        },
      }
    }
    case "MSGS_JUMP":
      return {
        ...state,
        messages: {
          ...m,
          cursor: action.to === "top" ? 0 : clamp(action.rowCount - 1, action.rowCount),
          // G is how a reader who scrolled back rejoins the tail.
          follow: { ...m.follow, pinned: m.follow.active && action.to === "bottom" },
        },
      }
    case "MSGS_PROMPT_OPEN":
      return { ...state, messages: { ...m, prompt: { mode: action.mode, input: "" } } }
    case "MSGS_PROMPT_APPEND":
      if (m.prompt === null) {
        return state
      }
      return {
        ...state,
        messages: { ...m, prompt: { ...m.prompt, input: m.prompt.input + action.char } },
      }
    case "MSGS_PROMPT_BACKSPACE":
      if (m.prompt === null) {
        return state
      }
      return {
        ...state,
        messages: { ...m, prompt: { ...m.prompt, input: m.prompt.input.slice(0, -1) } },
      }
    case "MSGS_PROMPT_SET":
      return m.prompt === null
        ? null
        : { ...state, messages: { ...m, prompt: { ...m.prompt, input: action.input } } }
    case "MSGS_PROMPT_CANCEL":
      return { ...state, messages: { ...m, prompt: null } }
    case "MSGS_COLUMN_MOVE": {
      if (action.columnCount === 0) {
        return { ...state, messages: { ...m, column: 0 } }
      }
      const next = Math.max(0, Math.min(m.column + action.delta, action.columnCount - 1))
      return { ...state, messages: { ...m, column: next } }
    }
    case "MSGS_COLUMN_JUMP":
      return {
        ...state,
        messages: {
          ...m,
          column: action.to === "first" ? 0 : Math.max(0, action.columnCount - 1),
        },
      }
    case "MSGS_COLUMN_HIDE":
    case "MSGS_COLUMNS_TOGGLE": {
      const hidden = m.hiddenColumns.includes(action.path)
        ? m.hiddenColumns.filter((p) => p !== action.path)
        : [...m.hiddenColumns, action.path]
      // The column cursor indexes the *visible* set, so hiding under it would leave the
      // cursor pointing at a different column than the one you were looking at.
      return { ...state, messages: { ...m, hiddenColumns: hidden, column: 0 } }
    }
    case "MSGS_COLUMNS_OPEN":
      return { ...state, messages: { ...m, columnPicker: 0 } }
    case "MSGS_COLUMNS_CLOSE":
      return { ...state, messages: { ...m, columnPicker: null } }
    case "MSGS_COLUMNS_MOVE": {
      if (m.columnPicker === null || action.rowCount === 0) {
        return null
      }
      const next = Math.max(0, Math.min(m.columnPicker + action.delta, action.rowCount - 1))
      return { ...state, messages: { ...m, columnPicker: next } }
    }
    case "MSGS_COLUMNS_RESET":
      return { ...state, messages: { ...m, hiddenColumns: [], column: 0 } }
    case "MSGS_SORT_CYCLE":
      // Sorting reorders the loaded window only, so the row cursor is meaningless
      // afterwards — send it to the top rather than leave it on an arbitrary row.
      return { ...state, messages: { ...m, sort: cycleSort(m.sort, action.path), cursor: 0 } }
    case "MSGS_SET_RANGE":
      // mode mirrors the range so the app header (spec 001) needs no second source.
      // The filter survives: it is a question about the data, not about the window, and
      // re-typing it after every range change is the whole workflow (spec 010).
      // Follow does not survive: it tails the end of *this* window, and a new range means
      // a new end (spec 012).
      return {
        ...state,
        mode: action.range.kind,
        messages: {
          cursor: 0,
          range: action.range,
          prompt: null,
          jsEditor: null,
          column: 0,
          hiddenColumns: m.hiddenColumns,
          columnPicker: null,
          sort: UNSORTED,
          filter: m.filter,
          follow: NOT_FOLLOWING,
          confirm: null,
          confirmTyped: "",
          copy: null,
        },
      }
    case "MSGS_FILTER_OPEN":
      return { ...state, messages: { ...m, filter: { ...m.filter, active: true } } }
    case "MSGS_FILTER_CLOSE":
      return { ...state, messages: { ...m, filter: { ...m.filter, active: false } } }
    case "MSGS_FILTER_CLEAR":
      return { ...state, messages: { ...m, cursor: 0, filter: { query: "", active: false } } }
    case "MSGS_FILTER_APPEND":
      // The predicate applies as it is typed (spec 010), so the row under the cursor is
      // gone by the next keystroke — snap to the top of the new result set.
      return {
        ...state,
        messages: {
          ...m,
          cursor: 0,
          filter: { ...m.filter, query: m.filter.query + action.char },
        },
      }
    case "MSGS_JS_OPEN":
      return { ...state, messages: { ...m, jsEditor: action.source } }
    case "MSGS_JS_SET":
      // The textarea owns the buffer; this mirrors it into state so the compile error and
      // the row reservation stay in step with what is on screen.
      return m.jsEditor === null ? null : { ...state, messages: { ...m, jsEditor: action.source } }
    case "MSGS_JS_CANCEL":
      return { ...state, messages: { ...m, jsEditor: null } }
    case "MSGS_JS_APPLY": {
      if (m.jsEditor === null) {
        return null
      }
      // An empty editor clears the filter rather than applying an empty predicate.
      const source = m.jsEditor.trim()
      return {
        ...state,
        messages: {
          ...m,
          jsEditor: null,
          cursor: 0,
          filter: { query: source === "" ? "" : JS_PREFIX + m.jsEditor, active: false },
        },
      }
    }
    case "MSGS_FILTER_SET":
      // Accepting a suggestion replaces the text without applying it: enter is still the
      // only key that commits (spec 010).
      return { ...state, messages: { ...m, filter: { ...m.filter, query: action.query } } }
    case "MSGS_FILTER_BACKSPACE":
      return {
        ...state,
        messages: {
          ...m,
          cursor: 0,
          filter: { ...m.filter, query: m.filter.query.slice(0, -1) },
        },
      }
    case "MSGS_FOLLOW_TOGGLE":
      // Turning follow on pins the cursor to the newest row and starts unpaused; turning
      // it off drops the tail buffer and returns to the fetched window — `space` is the
      // way to freeze the tail without losing it (spec 012).
      return {
        ...state,
        messages: {
          ...m,
          cursor: 0,
          follow: m.follow.active ? NOT_FOLLOWING : { active: true, paused: false, pinned: true },
        },
      }
    case "MSGS_CONFIRM_OPEN":
      // The copy bar closes as its dialog opens: the destination is decided, and leaving a
      // list of other destinations under a modal that names one would be two answers to the
      // same question.
      return { ...state, messages: { ...m, confirm: action.pending, confirmTyped: "", copy: null } }
    case "MSGS_CONFIRM_TYPED":
      return m.confirm === null
        ? null
        : { ...state, messages: { ...m, confirmTyped: action.typed } }
    case "MSGS_CONFIRM_CLOSE":
      return { ...state, messages: { ...m, confirm: null, confirmTyped: "" } }
    case "MSGS_COPY_OPEN":
      return {
        ...state,
        messages: { ...m, copy: { row: action.row, choice: 0, topic: null, planning: false } },
      }
    case "MSGS_COPY_MOVE": {
      if (m.copy === null || action.rowCount === 0) {
        return null
      }
      const choice = Math.max(0, Math.min(m.copy.choice + action.delta, action.rowCount - 1))
      return { ...state, messages: { ...m, copy: { ...m.copy, choice } } }
    }
    case "MSGS_COPY_TOPIC":
      return m.copy === null
        ? null
        : { ...state, messages: { ...m, copy: { ...m.copy, topic: action.topic } } }
    case "MSGS_COPY_PLANNING":
      return m.copy === null
        ? null
        : { ...state, messages: { ...m, copy: { ...m.copy, planning: true } } }
    case "MSGS_COPY_CLOSE":
      return { ...state, messages: { ...m, copy: null } }
    case "MSGS_FOLLOW_PAUSE_TOGGLE":
      if (!m.follow.active) {
        return state
      }
      return { ...state, messages: { ...m, follow: { ...m.follow, paused: !m.follow.paused } } }
    default:
      return null
  }
}
