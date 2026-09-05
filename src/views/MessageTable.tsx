import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useMemo, useState } from "react"
import type { Dispatch } from "react"
import type { ClusterSession, ConnectCluster } from "@/clusterSession.ts"
import { useViewCommands, type RegisterViewCommands } from "@/commands/registry.ts"
import type { ClusterProfile } from "@/config/schema.ts"
import { copyDestinations, mappedTopic } from "@/config/siblings.ts"
import type { KafkaClient } from "@/kafka/types.ts"
import { halfPage, levelNav, listNav, modified, normalizeKey, pageNav } from "@/keys.ts"
import { produceNoun } from "@/replay/produce.ts"
import { confirmResponse, typedConfirmSatisfied, writeBlockedReason } from "@/safety/gate.ts"
import type { SchemaRegistry } from "@/schema/registry.ts"
import type { AppAction, MessagesState } from "@/state.ts"
import type { PromptMode } from "@/table/window.ts"

import { fieldMap, fitColumns, inferColumns, type Column } from "@/table/infer.ts"
import { splitLastTerm, suggest } from "@/filter/suggest.ts"
import { cellFilterTerm, withTerm } from "@/table/cellFilter.ts"
import { sortRows, type SortState } from "@/table/sort.ts"
import { FilterSuggestions } from "./FilterSuggestions.tsx"
import { filterMode, filterSource } from "./filterBarModel.ts"
import { ColumnPicker, columnPickerRows } from "./ColumnPicker.tsx"
import { CopyBar, copyBarRows } from "./CopyBar.tsx"
import { copyFlows } from "./copyFlow.ts"
import { JsFilterEditor, jsEditorRows } from "./JsFilterEditor.tsx"
import { Spinner } from "./Loading.tsx"
import { droppedLabel, tailLabel } from "@/table/tailBuffer.ts"
import {
  formatTimestamp,
  parseRangeInput,
  plannedCount,
  rangeSummary,
  resolvedSummary,
  sortWindow,
  trimLatestN,
  WINDOW_CAP,
} from "@/table/window.ts"
import { theme } from "@/theme.ts"
import type { DecodedMessage, PartitionMeta } from "@/types.ts"
import { viewInEditor } from "@/editor/view.ts"
import { FilterBar } from "./FilterBar.tsx"
import { rowCountLabel } from "./filterBarModel.ts"
import { editorDocument } from "./messageDoc.ts"
import { produceFlows } from "./produceFlows.ts"
import { windowStart } from "./topicListModel.ts"
import { useFilteredMessages, type FilteredMessages } from "./useFilteredMessages.ts"
import { useFilterPredicate } from "./useFilterPredicate.ts"
import { useFollowTail, type FollowTail } from "./useFollowTail.ts"
import { useMessageWindow, type ResolvedWindow, type WindowPhase } from "./useMessageWindow.ts"

export interface MessageTableProps {
  client: KafkaClient
  /** The subject side is needed too: crafting encodes against the latest schema (spec 015). */
  registry: SchemaRegistry
  topic: string
  /** The connected cluster — what a write is gated on and named after (spec 019). */
  profile: ClusterProfile
  /** Every configured profile: a cross-cluster copy picks its destination from these
   *  (spec 016), defaulting to the sibling env of this cluster's group (spec 023). */
  profiles: ClusterProfile[]
  /** Builds the destination's client + registry — the second, separate schema cache. */
  connect: ConnectCluster
  ui: MessagesState
  /** True while an overlay (help, palette) owns the keyboard — every key is ignored here. */
  suspended: boolean
  /** Publishes the focused row and column, and this view's actions, to the command palette
   *  (spec 021) — the reducer holds cursor indices, not the rows the broker returned. */
  registerCommands: RegisterViewCommands
  dispatch: Dispatch<AppAction>
}

// Rows the table does not get: app header, window line, column header (above), the
// filter/prompt bar (below), status reserve.
const CHROME_ROWS = 5
// Completion offers more fields than the table can show columns for: the table is bounded
// by width, the suggestion list only by its own limit.
const SUGGESTION_FIELDS = 200
const PART_COL = 4
const OFFSET_COL = 10
const TS_COL = 23
// Paths match the filter grammar's envelope roots, so sorting by `timestamp` and
// filtering on `timestamp:` name the same field.
const META_PATHS = new Set(["partition", "offset", "timestamp"])
const META_COLUMNS: Column[] = [
  { path: "partition", header: "part", width: PART_COL },
  { path: "offset", header: "offset", width: OFFSET_COL },
  { path: "timestamp", header: "timestamp (UTC)", width: TS_COL },
]
const GAP = 2

// Stable identity: a fresh [] every render would churn the tail hook's captured metadata.
const EMPTY_PARTITIONS: PartitionMeta[] = []

const PROMPT_LABELS = {
  offset: "offset",
  timestamp: "since (ISO or epoch ms)",
  latestN: "latest N",
} as const

export function MessageTable({
  client,
  registry,
  topic,
  profile,
  profiles,
  connect,
  ui,
  suspended,
  registerCommands,
  dispatch,
}: MessageTableProps) {
  const { width, height } = useTerminalDimensions()
  const renderer = useRenderer()
  const [reload, setReload] = useState(0)
  // The copy destination's connection outlives a single copy: password_cmd shells out to a
  // vault, and paying that per message would make the feature unusable (spec 016).
  const [destination, setDestination] = useState<ClusterSession | null>(null)
  const { rows, phase, error, resolved } = useMessageWindow(
    client,
    registry,
    topic,
    ui.range,
    reload,
  )

  const loaded = useMemo(() => {
    const sorted = sortWindow(rows)
    return ui.range.kind === "latestN" ? trimLatestN(sorted, ui.range.n) : sorted
  }, [rows, ui.range])

  // The predicate is compiled before any rows are touched: the tail filters arrivals as
  // they land, ahead of the buffer, so a narrow filter can follow a busy topic (spec 012).
  const filter = useFilterPredicate(ui.filter.query)
  const tail = useFollowTail(
    client,
    registry,
    topic,
    ui.range,
    loaded,
    resolved?.partitions ?? EMPTY_PARTITIONS,
    ui.follow,
    filter.predicate,
  )
  const filtered = useFilteredMessages(tail.rows ?? loaded, filter)
  // Sort after filtering: sorting the whole window and then filtering would reorder rows
  // under the cursor for no visible reason (spec 024).
  const display = useMemo(() => sortRows(filtered.rows, ui.sort), [filtered.rows, ui.sort])

  // One flatten per message per window, shared by inference and cell lookup (nfr/001).
  // Over the filtered rows, so the columns describe what is on screen.
  const maps = useMemo(
    () => display.map((m) => (m.value === null || m.decodeError ? null : fieldMap(m.decodedValue))),
    [display],
  )
  const columns = useMemo(
    () =>
      inferColumns(maps.filter((m): m is Map<string, string> => m !== null)).filter(
        (c) => !ui.hiddenColumns.includes(c.path),
      ),
    [maps, ui.hiddenColumns],
  )
  const valueBudget = width - 2 - (PART_COL + GAP) - (OFFSET_COL + GAP) - (TS_COL + GAP)
  const visibleColumns = fitColumns(columns, Math.max(valueBudget, 8), GAP)
  // The envelope columns are columns too: without them in the cursor's set you cannot
  // select — and therefore cannot sort by — partition, offset or timestamp (spec 024).
  const allColumns: Column[] = useMemo(() => [...META_COLUMNS, ...visibleColumns], [visibleColumns])

  // Pinned, the cursor is wherever the newest row is — that is what makes the view
  // auto-scroll while following, and moving off the bottom is what stops it (spec 012).
  const cursor = ui.follow.pinned
    ? Math.max(display.length - 1, 0)
    : Math.min(ui.cursor, Math.max(display.length - 1, 0))
  // Suggestions come from what is actually loaded — the inferred columns and the rows'
  // own values — so they describe this topic rather than a schema guess (spec 010 P2).
  // Suggestions describe the *topic*, so they are built from the unfiltered window. Using
  // the filtered rows collapses them exactly when they are needed: a half-typed field name
  // is a valid bare-word term, so it filters the table to nothing, which empties the
  // columns, which leaves nothing to complete from.
  const unfiltered = tail.rows ?? loaded
  const suggestionFields = useMemo(() => {
    if (!ui.filter.active && ui.columnPicker === null) {
      return []
    }
    const samples = unfiltered
      .filter((m) => m.value !== null && !m.decodeError)
      .map((m) => fieldMap(m.decodedValue))
    return inferColumns(samples, { maxColumns: SUGGESTION_FIELDS }).map((c) => c.path)
  }, [ui.filter.active, ui.columnPicker, unfiltered])
  const suggestions = useMemo(
    () =>
      ui.filter.active
        ? suggest({ query: ui.filter.query, columns: suggestionFields, rows: unfiltered })
        : [],
    [ui.filter.active, ui.filter.query, suggestionFields, unfiltered],
  )
  const [picked, setPicked] = useState(0)
  const selected = Math.min(picked, Math.max(suggestions.length - 1, 0))

  // The suggestion list and the JS box sit between the rows and the bar, so the rows have
  // to give up the space: shrinking the box alone is not enough, its children overflow and
  // push everything below off the screen.
  // Ordered like the picker itself: the sibling env first, prod never the default row
  // (specs 016, 023). Stable per profile list, so the bar's cursor does not move under it.
  const destinations = useMemo(() => copyDestinations(profiles, profile), [profiles, profile])
  const copyChoice = ui.copy === null ? 0 : Math.min(ui.copy.choice, destinations.length - 1)
  const copyTarget = destinations[copyChoice] ?? null

  const overlayRows =
    (suggestions.length > 0 ? suggestions.length + 1 : 0) +
    (ui.jsEditor === null ? 0 : jsEditorRows(ui.jsEditor)) +
    (ui.columnPicker === null ? 0 : columnPickerRows(suggestionFields.length)) +
    copyBarRows(ui.copy, destinations.length)
  const listHeight = Math.max(1, height - CHROME_ROWS - overlayRows)
  const start = windowStart(cursor, display.length, listHeight)
  const columnCursor = Math.min(ui.column, Math.max(allColumns.length - 1, 0))

  const applyPrompt = (mode: PromptMode, input: string): void => {
    const parsed = parseRangeInput(mode, input)
    if ("error" in parsed) {
      dispatch({ type: "SHOW_STATUS", message: parsed.error, kind: "error" })
      return
    }
    dispatch({ type: "MSGS_SET_RANGE", range: parsed.range })
  }

  // The $EDITOR-driven writes (specs 014, 015) live outside this file: none of them is
  // rendering, and all of them end in the same confirm dialog.
  const flows = produceFlows({
    renderer,
    client,
    registry,
    profile,
    topic,
    destination,
    dispatch,
    now: () => new Date(),
  })
  const copy = copyFlows({
    source: { profile, client, registry },
    connect,
    destination,
    onDestination: setDestination,
    dispatch,
    now: () => new Date(),
  })

  // The row and column the cursor is on, and everything that acts on them. Named rather
  // than inlined in the keymap because the command palette runs the same actions from the
  // same state (spec 021) — two copies would be two behaviours.
  const focusedRow = display[cursor]
  const focusedColumn = allColumns[columnCursor]

  const reloadWindow = (): void => {
    // A reload rebuilds the window the tail was seeded from, so the tail has to go with
    // it — otherwise the buffer keeps showing rows the new window never fetched.
    if (ui.follow.active) {
      dispatch({ type: "MSGS_FOLLOW_TOGGLE" })
    }
    setReload((r) => r + 1)
  }

  const sortByColumn = (): void => {
    if (focusedColumn) {
      dispatch({ type: "MSGS_SORT_CYCLE", path: focusedColumn.path })
    }
  }

  const hideFocusedColumn = (): void => {
    // Hiding an envelope column would leave a row with no identity, so only value columns
    // can go.
    if (focusedColumn && !META_PATHS.has(focusedColumn.path)) {
      dispatch({ type: "MSGS_COLUMN_HIDE", path: focusedColumn.path })
    }
  }

  const filterByCell = (): void => {
    if (!focusedColumn || !focusedRow) {
      return
    }
    const term = cellFilterTerm(focusedRow, focusedColumn.path)
    if (term === null) {
      return dispatch({
        type: "SHOW_STATUS",
        message: `${focusedColumn.header}: nothing to filter on here`,
      })
    }
    dispatch({ type: "MSGS_FILTER_SET", query: withTerm(ui.filter.query, term) })
  }

  // Seeded from the active JS filter so reopening edits it rather than starting over.
  const openJsFilter = (): void =>
    dispatch({
      type: "MSGS_JS_OPEN",
      source: filterMode(ui.filter.query) === "js" ? filterSource(ui.filter.query) : "",
    })

  const viewMessage = (): void => {
    if (focusedRow === undefined) {
      return
    }
    void viewInEditor(renderer, editorDocument(focusedRow, new Date()), "message.jsonc").catch(
      (error: unknown) =>
        dispatch({ type: "SHOW_STATUS", message: `editor: ${String(error)}`, kind: "error" }),
    )
  }

  useViewCommands(registerCommands, {
    focus: {
      topic: null,
      message: focusedRow !== undefined,
      column:
        focusedColumn === undefined
          ? null
          : {
              path: focusedColumn.path,
              header: focusedColumn.header,
              hideable: !META_PATHS.has(focusedColumn.path),
            },
      group: null,
    },
    actions: {
      reload: reloadWindow,
      sortColumn: sortByColumn,
      hideColumn: hideFocusedColumn,
      filterCell: filterByCell,
      jsFilter: openJsFilter,
      viewMessage,
      replay: () => (focusedRow === undefined ? undefined : flows.startReplay(focusedRow)),
      editReplay: () => (focusedRow === undefined ? undefined : flows.startEdit(focusedRow)),
      craft: () => flows.startCraft(),
      copy: () => (focusedRow === undefined ? undefined : copy.open(focusedRow, destinations)),
    },
  })

  useKeyboard((key) => {
    if (suspended) {
      return
    }
    const k = normalizeKey(key)
    const move = (delta: number) => dispatch({ type: "MSGS_MOVE", delta, rowCount: display.length })
    if (ui.confirm !== null) {
      // The whole keyboard belongs to the modal: confirmResponse is the only thing that can
      // answer it, and everything it does not recognise is swallowed rather than treated as
      // a decision (spec 019).
      const answer = confirmResponse(ui.confirm.prompt, k)
      if (answer === null) {
        return
      }
      const pending = ui.confirm
      if (answer === "confirm" && !typedConfirmSatisfied(pending.prompt, ui.confirmTyped)) {
        // A prod target is refused until its name is retyped (spec 016 P1). Refusing here
        // rather than disabling the key keeps the reason on screen instead of leaving a
        // dead keystroke to puzzle over.
        return dispatch({
          type: "SHOW_STATUS",
          message: `type ${pending.prompt.typeToConfirm ?? ""} to confirm a production write`,
          kind: "error",
        })
      }
      dispatch({ type: "MSGS_CONFIRM_CLOSE" })
      if (answer === "cancel") {
        return dispatch({
          type: "SHOW_STATUS",
          message: `${produceNoun(pending.action.kind)} cancelled`,
        })
      }
      return flows.runPending(pending)
    }
    if (ui.copy !== null) {
      // The copy bar owns the keyboard while it is open (spec 016), like the seek bar: a
      // stray `p` must not start a replay on the source cluster mid-copy.
      if (k.name === "escape") {
        return dispatch({ type: "MSGS_COPY_CLOSE" })
      }
      if (ui.copy.planning) {
        return
      }
      if (ui.copy.topic !== null) {
        // The <input> owns the text and submit; esc above is the only key it has no opinion
        // on. Backing out to the destination list is deliberate re-entry, not a key here.
        return
      }
      const rowNav = listNav(k)
      if (rowNav) {
        return dispatch({
          type: "MSGS_COPY_MOVE",
          delta: rowNav === "next" ? 1 : -1,
          rowCount: destinations.length,
        })
      }
      if (k.name === "return" || k.name === "enter") {
        return copyTarget === null
          ? undefined
          : copy.choose(copyTarget, ui.copy.row, mappedTopic(topic, profile, copyTarget))
      }
      return
    }
    if (ui.columnPicker !== null) {
      const field = suggestionFields[Math.min(ui.columnPicker, suggestionFields.length - 1)]
      const pageMove = pageNav(k)
      const rowNav = listNav(k)
      if (rowNav || pageMove) {
        const step = pageMove ? halfPage(columnPickerRows(suggestionFields.length)) : 1
        return dispatch({
          type: "MSGS_COLUMNS_MOVE",
          delta: (rowNav === "next" || pageMove === "down" ? 1 : -1) * step,
          rowCount: suggestionFields.length,
        })
      }
      if (k.name === "space" || key.sequence === " ") {
        return field === undefined
          ? undefined
          : dispatch({ type: "MSGS_COLUMNS_TOGGLE", path: field })
      }
      switch (k.name) {
        case "a":
          return dispatch({ type: "MSGS_COLUMNS_RESET" })
        case "escape":
        case "return":
        case "enter":
          // Toggles apply as you make them, so there is nothing to commit — both keys just
          // put the keyboard back on the table.
          return dispatch({ type: "MSGS_COLUMNS_CLOSE" })
      }
      return
    }
    if (ui.jsEditor !== null) {
      // The <textarea> owns the text, including ^w/^u/word motions/undo. Only apply and
      // cancel are ours.
      if (k.ctrl && k.name === "s") {
        return dispatch({ type: "MSGS_JS_APPLY" })
      }
      if (k.name === "escape") {
        return dispatch({ type: "MSGS_JS_CANCEL" })
      }
      return
    }
    if (ui.prompt) {
      // The <input> owns the text and submit; esc is the only key it has no opinion on.
      if (k.name === "escape") {
        dispatch({ type: "MSGS_PROMPT_CANCEL" })
      }
      return
    }
    if (ui.filter.active) {
      // The <input> owns the text: typing, backspace, ^w, ^u, word motions and enter all
      // reach it directly. Only the keys the input has no opinion about are handled here.
      if (k.ctrl && k.name === "y") {
        const suggestion = suggestions[selected]
        if (suggestion) {
          const { prefix } = splitLastTerm(ui.filter.query)
          dispatch({ type: "MSGS_FILTER_SET", query: prefix + suggestion.term })
          // Back to the top of whatever the new level offers (a namespace drills in).
          setPicked(0)
        }
        return
      }
      if (k.name === "escape") {
        return dispatch({ type: "MSGS_FILTER_CLEAR" })
      }
      // With a suggestion list open ^n/^p drive it; with none they walk the rows, so a
      // match can still be inspected without leaving the bar (spec 020).
      const typedNav = listNav(k, { letters: false })
      if (typedNav) {
        if (suggestions.length > 0) {
          setPicked((i) =>
            typedNav === "next" ? Math.min(i + 1, suggestions.length - 1) : Math.max(i - 1, 0),
          )
          return
        }
        return move(typedNav === "next" ? 1 : -1)
      }
      return
    }
    // ctrlPrev: false — `^p` belongs to the command palette in a base view (spec 021).
    const nav = listNav(k, { ctrlPrev: false })
    if (nav) {
      return move(nav === "next" ? 1 : -1)
    }
    const page = pageNav(k)
    if (page) {
      return move(page === "down" ? halfPage(listHeight) : -halfPage(listHeight))
    }
    // Not a switch case: terminals disagree on whether the space bar arrives as the name
    // "space" or as a bare " " sequence with no name (nfr/002).
    if (k.name === "space" || key.sequence === " ") {
      return dispatch({ type: "MSGS_FOLLOW_PAUSE_TOGGLE" })
    }
    // Not a switch case: "*" is shift+8 on many layouts, so it arrives with name "8" and
    // only the sequence carries the glyph (nfr/002).
    if (k.name === "*" || key.sequence === "*") {
      // vim's "search what is under the cursor". `f` is follow mode (spec 012), so the vim
      // reading gets this key.
      return filterByCell()
    }
    // The table is a grid, so h/l walk the column cursor here rather than the view stack
    // (spec 024) — esc is the unambiguous way out of the table.
    const column = levelNav(k)
    if (column) {
      return dispatch({
        type: "MSGS_COLUMN_MOVE",
        delta: column === "descend" ? 1 : -1,
        columnCount: allColumns.length,
      })
    }
    // ^p is the palette, not `p` (replay): a modified key is never a letter binding.
    if (modified(k)) {
      return
    }
    switch (k.name) {
      case "0":
        return dispatch({
          type: "MSGS_COLUMN_JUMP",
          to: "first",
          columnCount: allColumns.length,
        })
      case "$":
        return dispatch({
          type: "MSGS_COLUMN_JUMP",
          to: "last",
          columnCount: allColumns.length,
        })
      case "s":
        return sortByColumn()
      case "g":
        return dispatch({
          type: "MSGS_JUMP",
          to: k.shift ? "bottom" : "top",
          rowCount: display.length,
        })
      case "o":
        return dispatch({ type: "MSGS_PROMPT_OPEN", mode: "offset" })
      case "t":
        return dispatch({ type: "MSGS_PROMPT_OPEN", mode: "timestamp" })
      case "n":
        // shift+N crafts a new message from the subject's latest schema (spec 015). Not `c`
        // (columns) and deliberately not a bare letter next to `p`: the dialog commits on
        // shift+P, so trigger and confirm stay different keys.
        if (k.shift) {
          flows.startCraft()
          return
        }
        return dispatch({ type: "MSGS_PROMPT_OPEN", mode: "latestN" })
      case "b":
        return dispatch({ type: "MSGS_SET_RANGE", range: { kind: "beginning" } })
      case "r":
        return reloadWindow()
      case "f":
        return dispatch({ type: "MSGS_FOLLOW_TOGGLE" })
      case "c":
        return dispatch({ type: "MSGS_COLUMNS_OPEN" })
      case "e":
        // A separate key for a separate path (spec 014): this one re-encodes, so it must not
        // be reachable by a slip of the finger from `p`, which promises byte-exactness. The
        // dialog still commits on shift+R, so trigger and confirm stay different keys.
        return focusedRow === undefined ? undefined : flows.startEdit(focusedRow)
      case "p":
        // Deliberately not `R`, the obvious mnemonic: `R` is the gate's confirm key for a
        // replay (spec 019), and a held key repeating would then open the dialog and answer
        // it from one keystroke — a production write nobody read. Trigger and confirm must
        // be different keys.
        return focusedRow === undefined ? undefined : flows.startReplay(focusedRow)
      case "y":
        // vim's yank. Deliberately not `c` (columns) and not `shift+C`, which is this
        // dialog's own confirm key (spec 019): trigger and confirm must be different keys,
        // or one held key opens a cross-cluster write and answers it.
        return focusedRow === undefined ? undefined : copy.open(focusedRow, destinations)
      case "-":
        return hideFocusedColumn()
      case "/":
        return dispatch({ type: "MSGS_FILTER_OPEN" })
      case "=":
        return openJsFilter()
      case "backspace":
        // Backspace is "undo the narrowing" from the table, mirroring what it does inside
        // the bar: there it deletes a character, here it deletes the whole filter.
        if (ui.filter.query !== "") {
          dispatch({ type: "MSGS_FILTER_CLEAR" })
        }
        return
      case "escape":
        // Claim esc only while a filter is applied; otherwise leave it to App's ascend
        // (spec 020) — App sees the same snapshot, so exactly one meaning fires.
        if (ui.filter.query !== "") {
          dispatch({ type: "MSGS_FILTER_CLEAR" })
        }
        return
      case "return":
      case "enter":
        // No intermediate detail pane (spec 008 as amended): the lossless $EDITOR view
        // is the message view.
        //
        // `l` is deliberately NOT a synonym here (spec 020): it suspends the TUI for an
        // external process, and `h` cannot bring it back — the descend/ascend pair would
        // stop being a pair. The table is the deepest level h/l navigate to; opening a
        // message stays an explicit act, on enter.
        return viewMessage()
    }
  })

  const planned = resolved?.starts ? plannedCount(resolved.starts, resolved.partitions) : null
  const capped = (planned !== null && planned > BigInt(WINDOW_CAP)) || rows.length >= WINDOW_CAP

  return (
    <box flexDirection="column" flexGrow={1} paddingX={1}>
      <WindowLine
        ui={ui}
        filtered={filtered}
        phase={phase}
        capped={capped}
        resolved={resolved}
        tail={tail}
        writeBlocked={writeBlockedReason(profile) !== null}
      />
      <HeaderRow columns={allColumns} column={columnCursor} sort={ui.sort} />
      {/* flexShrink is 0 by default in this layout engine, so without it the row list
          keeps its full height and pushes the suggestion list, the JS box and the filter
          bar off the bottom of the screen. */}
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1}>
        {phase === "error" && <text fg={theme.error}>consume failed — {error}</text>}
        {phase === "loading" && display.length === 0 && (
          <box flexDirection="row" gap={1}>
            <Spinner />
            <text fg={theme.textDim}>consuming…</text>
          </box>
        )}
        {phase === "done" && display.length === 0 && (
          <text fg={theme.textDim}>
            {filtered.filtering && filtered.total > 0 ? "no rows match" : "window is empty"}
          </text>
        )}
        {display.slice(start, start + listHeight).map((row, i) => (
          <Row
            key={`${row.partition}:${row.offset}`}
            row={row}
            fields={maps[start + i] ?? null}
            valueColumns={visibleColumns}
            selected={start + i === cursor}
          />
        ))}
      </box>
      {/* Input bars live at the bottom, as in presto/lane/monq (AGENTS.md). */}
      {ui.copy !== null && (
        <CopyBar
          copy={ui.copy}
          destinations={destinations}
          chosen={copyTarget}
          dispatch={dispatch}
          onSubmit={(destTopic) =>
            ui.copy !== null && copyTarget !== null
              ? copy.run(ui.copy, copyTarget, destTopic)
              : undefined
          }
        />
      )}
      {ui.columnPicker !== null && (
        <ColumnPicker
          fields={suggestionFields}
          hidden={ui.hiddenColumns}
          cursor={Math.min(ui.columnPicker, Math.max(suggestionFields.length - 1, 0))}
        />
      )}
      {ui.jsEditor !== null && (
        <JsFilterEditor
          source={ui.jsEditor}
          onChange={(source) => dispatch({ type: "MSGS_JS_SET", source })}
        />
      )}
      <FilterSuggestions suggestions={suggestions} selected={selected} />
      {ui.prompt ? (
        <PromptLine
          prompt={ui.prompt}
          dispatch={dispatch}
          onSubmit={(input) => applyPrompt(ui.prompt?.mode ?? "offset", input)}
        />
      ) : (
        <FilterBar filter={ui.filter} result={filtered} dispatch={dispatch} />
      )}
    </box>
  )
}

function WindowLine({
  ui,
  filtered,
  phase,
  capped,
  resolved,
  tail,
  writeBlocked,
}: {
  ui: MessagesState
  filtered: FilteredMessages
  phase: WindowPhase
  capped: boolean
  resolved: ResolvedWindow | null
  tail: FollowTail
  writeBlocked: boolean
}) {
  const where =
    resolved === null
      ? "resolving…"
      : resolved.starts === null
        ? `${resolved.partitions.length} parts (broker-resolved)`
        : resolvedSummary(resolved.starts, resolved.partitions)
  const follow = tailLabel(tail.status)
  // Eviction and backpressure both mean rows existed that this window will never show —
  // stated, never silently truncated (nfr/004).
  const dropped = droppedLabel(tail.dropped)
  return (
    <box flexDirection="row" width="100%" gap={2}>
      <text fg={theme.secondary}>{rangeSummary(ui.range)}</text>
      <text fg={theme.textDim}>{where}</text>
      <box flexGrow={1} />
      {/* Spec 019 P1: a disabled write is stated up front, not only when a key is pressed —
          "read-only" is why `p` will refuse, visible before you reach for it. */}
      {writeBlocked && <text fg={theme.textDim}>read-only</text>}
      {dropped !== null && <text fg={theme.warning}>{dropped}</text>}
      {capped && tail.rows === null && <text fg={theme.warning}>capped at {WINDOW_CAP}</text>}
      <text fg={filtered.filtering ? theme.text : theme.textDim}>
        {rowCountLabel(filtered.matched, filtered.total, filtered.filtering)}
      </text>
      {follow === null ? (
        // Deliberately the quiet end of spec 025: a consume streams into the rows below,
        // so it gets a spinner beside the label and never takes the pane.
        <box flexDirection="row" gap={1}>
          {phase === "loading" && <Spinner />}
          <text fg={phase === "done" ? theme.success : theme.textDim}>
            {phase === "loading" ? "loading" : phase === "done" ? "end" : "error"}
          </text>
        </box>
      ) : (
        <text fg={FOLLOW_FG[tail.status]}>{follow}</text>
      )}
    </box>
  )
}

const FOLLOW_FG: Record<FollowTail["status"], string> = {
  off: theme.textDim,
  following: theme.success,
  paused: theme.warning,
  error: theme.error,
}

function PromptLine({
  prompt,
  dispatch,
  onSubmit,
}: {
  prompt: NonNullable<MessagesState["prompt"]>
  dispatch: Dispatch<AppAction>
  onSubmit: (input: string) => void
}) {
  return (
    <box flexDirection="row" width="100%" gap={1} backgroundColor={theme.panelBg}>
      <text fg={theme.primary}>{PROMPT_LABELS[prompt.mode]}:</text>
      <input
        value={prompt.input}
        onInput={(input: string) => dispatch({ type: "MSGS_PROMPT_SET", input })}
        onSubmit={onSubmit as never}
        focused
        flexGrow={1}
        backgroundColor={theme.panelBg}
        textColor={theme.text}
        cursorColor={theme.primary}
      />
    </box>
  )
}

function HeaderRow({
  columns,
  column,
  sort,
}: {
  columns: Column[]
  column: number
  sort: SortState
}) {
  return (
    <box flexDirection="row" width="100%">
      {columns.map((c, i) => (
        <text
          key={c.path}
          fg={i === column ? theme.primary : theme.secondary}
          bg={i === column ? theme.panelBg : undefined}
        >
          {fit(
            sort.path === c.path ? `${sort.direction === "asc" ? "▲" : "▼"}${c.header}` : c.header,
            c.width,
          ) + "  "}
        </text>
      ))}
    </box>
  )
}

function Row({
  row,
  fields,
  valueColumns,
  selected,
}: {
  row: DecodedMessage
  fields: Map<string, string> | null
  valueColumns: Column[]
  selected: boolean
}) {
  const meta =
    `p${row.partition}`.padEnd(PART_COL + GAP) +
    row.offset.toString().padStart(OFFSET_COL) +
    " ".repeat(GAP) +
    formatTimestamp(row.timestamp).padEnd(TS_COL + GAP)
  return (
    <box flexDirection="row" width="100%" backgroundColor={selected ? theme.panelBg : undefined}>
      <text fg={selected ? theme.text : theme.textDim}>{meta}</text>
      <ValueCells row={row} fields={fields} columns={valueColumns} selected={selected} />
    </box>
  )
}

function ValueCells({
  row,
  fields,
  columns,
  selected,
}: {
  row: DecodedMessage
  fields: Map<string, string> | null
  columns: Column[]
  selected: boolean
}) {
  if (row.value === null) {
    // A tombstone is a statement, not missing data — never render it as a blank row.
    return <text fg={theme.warning}>∅ tombstone</text>
  }
  if (row.decodeError) {
    return <text fg={theme.error}>decode failed — {row.decodeError}</text>
  }
  // An absent field renders blank — visually distinct from the literal "null" (nfr/006).
  const cells = columns.map((c) => fit(fields?.get(c.path) ?? "", c.width)).join("  ")
  return <text fg={selected ? theme.primary : theme.text}>{cells}</text>
}

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}
