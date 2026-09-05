import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useState } from "react"
import type { Dispatch } from "react"
import { useViewCommands, type RegisterViewCommands } from "@/commands/registry.ts"
import type { ClusterProfile } from "@/config/schema.ts"
import { formatTotalLag, visibleGroupRows, type GroupRow, type GroupSort } from "@/kafka/groups.ts"
import type { FetchRange } from "@/kafka/range.ts"
import type { KafkaClient } from "@/kafka/types.ts"
import {
  halfPage,
  levelNav,
  listNav,
  modified,
  normalizeKey,
  pageNav,
  type NormalizedKey,
} from "@/keys.ts"
import { confirmResponse, typedConfirmSatisfied, writeBlockedReason } from "@/safety/gate.ts"
import { SEEK_TARGETS, seekRange } from "@/seek/model.ts"
import { commitSeek, planSeek, type PendingSeek } from "@/seek/run.ts"
import type { AppAction, GroupSeekState, GroupsState } from "@/state.ts"
import { theme } from "@/theme.ts"
import {
  GroupMembersPane,
  GroupOffsetsPane,
  groupPaneHeight,
  groupPaneRows,
} from "./GroupPanes.tsx"
import { OffsetSeekBar, seekBarRows } from "./OffsetSeek.tsx"
import { windowStart } from "./topicListModel.ts"
import { useGroups, type GroupsPhase } from "./useGroups.ts"

// Consumer groups for one topic (spec 017): state, members, total lag in the list; the
// per-partition offsets and the member assignment in the bottom pane.
//
// The one thing here that mutates is the offset seek (spec 018): `o` opens the target bar,
// the plan is resolved against the broker, and the gate's confirm dialog (019) is what
// commits it. Everything else is read-only.

export interface GroupListProps {
  client: KafkaClient
  /** The topic whose lag is being reported. Lag is per topic, so there is no group view
   *  without one — the caller opens this from a topic row. */
  topic: string
  /** The connected cluster, for the write gate — null keeps `o` refusing with a reason. */
  profile: ClusterProfile | null
  ui: GroupsState
  /** True while an overlay (help, palette) owns the keyboard — every key is ignored here. */
  suspended: boolean
  /** Publishes the cursor group and this view's actions to the command palette (spec 021). */
  registerCommands: RegisterViewCommands
  dispatch: Dispatch<AppAction>
}

// Rows the list does not get: app header, column header (above), the filter bar (below),
// status reserve.
const CHROME_ROWS = 4
const STATE_COL = 20
const MEMBERS_COL = 8
const LAG_COL = 14
// The pane never squeezes the group list below this — the list is the view.
const MIN_LIST_ROWS = 3

const SORT_LABELS: Record<GroupSort, string> = { name: "name", lag: "lag", state: "state" }

export function GroupList({
  client,
  topic,
  profile,
  ui,
  suspended,
  registerCommands,
  dispatch,
}: GroupListProps) {
  const { width, height } = useTerminalDimensions()
  const [reload, setReload] = useState(0)
  const { rows, phase, error, undescribed } = useGroups(client, topic, reload)

  const visible = visibleGroupRows(rows ?? [], {
    filter: ui.filter,
    showEphemeral: ui.showEphemeral,
    onlyTopic: ui.onlyTopic,
    sort: ui.sort,
  })
  const cursor = Math.min(ui.cursor, Math.max(visible.length - 1, 0))
  const cursorRow = visible[cursor]
  const paneItems = paneItemCount(ui, cursorRow)
  // One helper for both the height the list gives up and the rows the pane draws: two
  // counts would drift and push the pane off the bottom of the screen (AGENTS.md). The
  // seek bar is charged first — it is the thing being typed into.
  const seekRows = seekBarRows(ui.seek)
  const paneBudget = height - CHROME_ROWS - MIN_LIST_ROWS - seekRows
  // With no row under the cursor there is nothing to describe, so the pane neither draws
  // nor charges the list for its rows.
  const paneOpen = ui.pane !== "none" && cursorRow !== undefined
  const paneHeight = paneOpen ? groupPaneHeight(paneItems, paneBudget) : 0
  const paneRows = paneOpen ? groupPaneRows(paneItems, paneBudget) : 0
  const paneMaxOffset = Math.max(0, paneItems - paneRows)
  // Clamp at render too: a resize can shrink the pane under an already-scrolled offset.
  const paneOffset = Math.min(ui.paneOffset, paneMaxOffset)
  const listHeight = Math.max(MIN_LIST_ROWS, height - CHROME_ROWS - paneHeight - seekRows)
  const start = windowStart(cursor, visible.length, listHeight)

  const failed = (what: string, failure: unknown): void => {
    dispatch({
      type: "SHOW_STATUS",
      message: `${what} — ${failure instanceof Error ? failure.message : String(failure)}`,
      kind: "error",
    })
  }

  // Resolving the plan is a broker round trip: the group's state and its committed offsets
  // are read *now*, not taken from the row the list painted, which may be minutes old.
  const startPlan = (seek: GroupSeekState, range: FetchRange): void => {
    dispatch({ type: "GROUPS_SEEK_PLANNING" })
    const groupId = seek.groupId
    void planSeek({ client, profile, groupId, topic, range, now: () => new Date() }).then(
      (outcome) => {
        if (outcome.kind === "confirm") {
          return dispatch({ type: "GROUPS_SEEK_PLANNED", groupId, pending: outcome.pending })
        }
        dispatch({ type: "GROUPS_SEEK_CANCEL" })
        dispatch({ type: "SHOW_STATUS", message: `seek: ${outcome.reason}`, kind: "error" })
      },
      (failure: unknown) => {
        dispatch({ type: "GROUPS_SEEK_CANCEL" })
        failed("seek: nothing written", failure)
      },
    )
  }

  const chooseTarget = (seek: GroupSeekState): void => {
    const target = SEEK_TARGETS[seek.choice]
    if (target === undefined) {
      return
    }
    if (target.needsValue) {
      return dispatch({ type: "GROUPS_SEEK_TYPE", value: "" })
    }
    const parsed = seekRange(target.kind, "")
    if ("error" in parsed) {
      return dispatch({ type: "SHOW_STATUS", message: `seek: ${parsed.error}`, kind: "error" })
    }
    startPlan(seek, parsed.range)
  }

  const submitValue = (seek: GroupSeekState, value: string): void => {
    const target = SEEK_TARGETS[seek.choice]
    if (target === undefined) {
      return
    }
    const parsed = seekRange(target.kind, value)
    if ("error" in parsed) {
      // The bar stays open: a typo is corrected in place, not retyped from the picker.
      return dispatch({ type: "SHOW_STATUS", message: `seek: ${parsed.error}`, kind: "error" })
    }
    startPlan(seek, parsed.range)
  }

  const runSeek = (pending: PendingSeek): void => {
    // Reload either way: on success the committed offsets moved, and on failure the write
    // may still have moved some of them — the list must show what is true, not what was
    // asked for.
    void commitSeek(client, () => profile, pending).then(
      (result) => {
        dispatch({
          type: "SHOW_STATUS",
          message: `seek: ${result.message}`,
          kind: result.ok ? "success" : "error",
        })
        setReload((n) => n + 1)
      },
      (failure: unknown) => {
        failed("seek failed", failure)
        setReload((n) => n + 1)
      },
    )
  }

  // A blocked write is refused with its reason rather than the key going dead: an absent
  // command reads as "topiq cannot do this", which is wrong (spec 019 P1). The palette
  // lists it the same way, with the reason on the row.
  const openSeek = (): void => {
    const blocked = writeBlockedReason(profile)
    if (blocked !== null) {
      return dispatch({ type: "SHOW_STATUS", message: `seek: ${blocked}`, kind: "error" })
    }
    if (cursorRow === undefined) {
      return
    }
    dispatch({ type: "GROUPS_SEEK_OPEN", groupId: cursorRow.groupId })
  }

  // Lag is a moving number; a stale one misleads (spec 017 P2).
  const refreshGroups = (): void => {
    setReload((n) => n + 1)
    dispatch({ type: "SHOW_STATUS", message: `refreshing groups on ${topic}…` })
  }

  useViewCommands(registerCommands, {
    focus: {
      topic: null,
      message: false,
      column: null,
      group: cursorRow?.groupId ?? null,
    },
    actions: { refreshGroups, seekOffsets: openSeek },
  })

  const handleSeekKey = (seek: GroupSeekState, k: NormalizedKey): void => {
    if (seek.pending !== null) {
      // The modal owns the keyboard outright: confirmResponse is the only thing that can
      // answer it, and everything else is swallowed rather than read as a decision (019).
      const answer = confirmResponse(seek.pending.prompt, k)
      if (answer === "confirm" && !typedConfirmSatisfied(seek.pending.prompt, ui.seekTyped)) {
        // Prod is refused until its name is retyped (spec 016/019) — the reason stays on
        // screen rather than the key simply doing nothing.
        return dispatch({
          type: "SHOW_STATUS",
          message: `type ${seek.pending.prompt.typeToConfirm ?? ""} to confirm a production write`,
          kind: "error",
        })
      }
      if (answer === null) {
        return
      }
      const pending = seek.pending
      dispatch({ type: "GROUPS_SEEK_CANCEL" })
      if (answer === "cancel") {
        dispatch({ type: "SHOW_STATUS", message: "seek cancelled" })
        return
      }
      runSeek(pending)
      return
    }
    if (k.name === "escape") {
      dispatch({ type: "GROUPS_SEEK_CANCEL" })
      return
    }
    if (seek.planning || seek.value !== null) {
      // Planning: nothing to answer yet. Typing: the <input> owns the text and submit —
      // ^w/^u/word motions/undo are its, not a keymap's.
      return
    }
    if (k.name === "return" || k.name === "enter" || k.name === "space") {
      return chooseTarget(seek)
    }
    const nav = listNav(k)
    const level = levelNav(k)
    const delta =
      nav === "next" || level === "descend" ? 1 : nav === "prev" || level === "ascend" ? -1 : 0
    if (delta !== 0) {
      dispatch({ type: "GROUPS_SEEK_MOVE", delta })
    }
  }

  useKeyboard((key) => {
    if (suspended) {
      return
    }
    const k = normalizeKey(key)
    const move = (delta: number) =>
      dispatch({ type: "GROUPS_MOVE", delta, rowCount: visible.length })
    if (ui.seek !== null) {
      return handleSeekKey(ui.seek, k)
    }
    if (ui.filterActive) {
      // The <input> owns the text: typing, backspace, ^w, ^u, word motions and enter all
      // reach it directly. Only the keys it has no opinion about are handled here.
      if (k.name === "escape") {
        return dispatch({ type: "GROUPS_FILTER_CLEAR" })
      }
      const typedNav = listNav(k, { letters: false })
      if (typedNav) {
        return move(typedNav === "next" ? 1 : -1)
      }
      return
    }
    // Shift makes j/k drive the pane instead of the group cursor — the pane describes the
    // cursor group, so scrolling it must not move off that group.
    if (paneOpen && k.shift && (k.name === "j" || k.name === "k")) {
      return dispatch({
        type: "GROUPS_PANE_SCROLL",
        delta: k.name === "j" ? 1 : -1,
        maxOffset: paneMaxOffset,
      })
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
    // ^p is the palette, not `p` (replay): a modified key is never a letter binding.
    if (modified(k)) {
      return
    }
    switch (k.name) {
      case "g":
        return dispatch({
          type: "GROUPS_JUMP",
          to: k.shift ? "bottom" : "top",
          rowCount: visible.length,
        })
      // The offsets are what a group row is *about*, so enter opens them too.
      case "return":
      case "enter":
      case "p":
        return dispatch({ type: "GROUPS_PANE", pane: "partitions" })
      case "m":
        return dispatch({ type: "GROUPS_PANE", pane: "members" })
      case "/":
        return dispatch({ type: "GROUPS_FILTER_OPEN" })
      case "backspace":
        if (ui.filter !== "") {
          return dispatch({ type: "GROUPS_FILTER_CLEAR" })
        }
        return
      case "t":
        return dispatch({ type: "GROUPS_TOGGLE_ONLY_TOPIC" })
      case "e":
        return dispatch({ type: "GROUPS_TOGGLE_EPHEMERAL" })
      case "s":
        return dispatch({ type: "GROUPS_CYCLE_SORT" })
      case "o":
        // Deliberately not `S`: shift+S is the gate's confirm key for a seek (spec 019), and
        // a held key would then open the dialog and answer it in one stroke — an offset
        // reset nobody read. `o` is "offset", the same mnemonic the fetch prompt uses.
        return openSeek()
      case "r":
        return refreshGroups()
      case "escape":
        // Claim esc for view-local dismissals; otherwise leave it to App's ascend
        // (spec 020) — App sees the same snapshot, so exactly one meaning fires.
        if (ui.filter !== "") {
          dispatch({ type: "GROUPS_FILTER_CLEAR" })
        } else if (ui.pane !== "none") {
          dispatch({ type: "GROUPS_PANE", pane: ui.pane })
        }
        return
    }
  })

  const nameWidth = Math.max(12, width - STATE_COL - MEMBERS_COL - LAG_COL - 4)
  // Narrowed once so the submit callback closes over a non-null seek rather than re-reading
  // `ui.seek` when it fires.
  const seekState = ui.seek
  return (
    <box flexDirection="column" flexGrow={1} paddingX={1}>
      <HeaderRow sort={ui.sort} nameWidth={nameWidth} />
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1}>
        {rows === null && error === null && <text fg={theme.textDim}>loading groups…</text>}
        {error !== null && <text fg={theme.error}>failed to list groups — {error}</text>}
        {rows !== null && error === null && visible.length === 0 && (
          <text fg={theme.textDim}>{emptyLabel(ui)}</text>
        )}
        {visible.slice(start, start + listHeight).map((row, i) => (
          <Row
            key={row.groupId}
            row={row}
            phase={phase}
            selected={start + i === cursor}
            nameWidth={nameWidth}
          />
        ))}
      </box>
      {paneOpen && ui.pane === "partitions" && cursorRow && (
        <GroupOffsetsPane
          groupId={cursorRow.groupId}
          offsets={cursorRow.detail?.offsets ?? []}
          offset={paneOffset}
          rows={paneRows}
        />
      )}
      {paneOpen && ui.pane === "members" && cursorRow && (
        <GroupMembersPane
          groupId={cursorRow.groupId}
          members={cursorRow.detail?.members ?? []}
          offset={paneOffset}
          rows={paneRows}
        />
      )}
      {/* Input bars live at the bottom, as in presto/lane/monq (AGENTS.md). */}
      <FilterLine
        ui={ui}
        topic={topic}
        phase={phase}
        undescribed={undescribed}
        shown={visible.length}
        total={rows?.length ?? 0}
        dispatch={dispatch}
      />
      {seekState !== null && (
        <OffsetSeekBar
          seek={seekState}
          topic={topic}
          dispatch={dispatch}
          onSubmit={(value) => submitValue(seekState, value)}
        />
      )}
    </box>
  )
}

function paneItemCount(ui: GroupsState, row: GroupRow | undefined): number {
  if (ui.pane === "partitions") {
    return row?.detail?.offsets.length ?? 0
  }
  if (ui.pane === "members") {
    return row?.detail?.members.length ?? 0
  }
  return 0
}

function emptyLabel(ui: GroupsState): string {
  if (ui.filter !== "") {
    return "no groups match"
  }
  return ui.onlyTopic ? "no group consumes this topic — t shows every group" : "no consumer groups"
}

function FilterLine({
  ui,
  topic,
  phase,
  undescribed,
  shown,
  total,
  dispatch,
}: {
  ui: GroupsState
  topic: string
  phase: GroupsPhase
  undescribed: number
  shown: number
  total: number
  dispatch: Dispatch<AppAction>
}) {
  const filterShown = ui.filterActive || ui.filter !== ""
  return (
    <box flexDirection="row" width="100%" gap={2}>
      {filterShown ? (
        <>
          <text fg={theme.primary}>/</text>
          {ui.filterActive ? (
            <input
              value={ui.filter}
              onInput={(query: string) => dispatch({ type: "GROUPS_FILTER_SET", query })}
              onSubmit={() => dispatch({ type: "GROUPS_FILTER_CLOSE" })}
              placeholder="group id"
              focused
              flexGrow={1}
              backgroundColor={theme.bg}
              textColor={theme.text}
              placeholderColor={theme.textDim}
              cursorColor={theme.primary}
            />
          ) : (
            <text fg={theme.text}>{ui.filter}</text>
          )}
        </>
      ) : (
        <box />
      )}
      <box flexGrow={1} />
      {(phase === "listing" || phase === "lag") && <text fg={theme.textDim}>reading lag…</text>}
      {phase === "ready" && undescribed > 0 && (
        <text fg={theme.warning}>{undescribed} not described</text>
      )}
      <text fg={theme.textDim}>{topic}</text>
      {ui.onlyTopic ? (
        <text fg={theme.textDim}>this topic</text>
      ) : (
        <text fg={theme.warning}>all groups</text>
      )}
      {ui.showEphemeral && <text fg={theme.warning}>topiq readers shown</text>}
      <text fg={theme.textDim}>
        {shown}/{total} groups
      </text>
    </box>
  )
}

function HeaderRow({ sort, nameWidth }: { sort: GroupSort; nameWidth: number }) {
  const mark = (col: GroupSort) => (sort === col ? "▼" : " ")
  return (
    <box flexDirection="row" width="100%">
      <text fg={theme.secondary}>{`${mark("name")}group`.padEnd(nameWidth)}</text>
      <text fg={theme.secondary}>{`${mark("state")}${SORT_LABELS.state}`.padEnd(STATE_COL)}</text>
      <text fg={theme.secondary}>{"members".padStart(MEMBERS_COL)}</text>
      <text fg={theme.secondary}>{`${mark("lag")}lag`.padStart(LAG_COL)}</text>
    </box>
  )
}

// Broker-side group states (kafkajs ConsumerGroupState). Rebalancing is amber because lag
// read mid-rebalance is a snapshot of a moving target, not a steady figure.
const STATE_FG: Record<string, string> = {
  Stable: theme.success,
  Empty: theme.textDim,
  PreparingRebalance: theme.warning,
  CompletingRebalance: theme.warning,
  Dead: theme.error,
  Unknown: theme.textMuted,
}

function Row({
  row,
  phase,
  selected,
  nameWidth,
}: {
  row: GroupRow
  phase: GroupsPhase
  selected: boolean
  nameWidth: number
}) {
  const name =
    row.groupId.length > nameWidth ? `${row.groupId.slice(0, nameWidth - 1)}…` : row.groupId
  const nameFg = selected ? theme.primary : row.ephemeral ? theme.textMuted : theme.text
  return (
    <box flexDirection="row" width="100%" backgroundColor={selected ? theme.panelBg : undefined}>
      <text fg={nameFg}>{name.padEnd(nameWidth)}</text>
      <text fg={STATE_FG[row.state] ?? theme.text}>{row.state.padEnd(STATE_COL)}</text>
      <text fg={theme.textDim}>{row.memberCount.toString().padStart(MEMBERS_COL)}</text>
      <text fg={selected ? theme.text : theme.textDim}>
        {lagCell(row, phase).padStart(LAG_COL)}
      </text>
    </box>
  )
}

/** Unmeasured lag never prints as a number: "…" while the fetch is in flight, "?" once it
 *  has finished without an answer for this group, "—" when the group has committed nothing
 *  on the topic (spec 017). */
function lagCell(row: GroupRow, phase: GroupsPhase): string {
  if (row.lag !== null) {
    return formatTotalLag(row.lag)
  }
  return phase === "ready" ? "?" : "…"
}
