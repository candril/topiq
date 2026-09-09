import type { MessageFollowState, MessageScanState } from "@/state/types.ts"

// The command surface as data (spec 021). Types only: `buildCommands` decides which of
// these exist right now, `runCommand` decides what each one does, and neither knows about
// the other's half. A command that carried its own `execute(ctx)` would drag every
// dependency the behaviour needs into the list that only wants to describe it — lane's
// spec 010 records where that ends up.

/** Section order in the palette — fixed, so the list does not reshuffle as you type. */
export const CATEGORY_ORDER = [
  "Topic",
  "Fetch",
  "Filter",
  "Message",
  "Replay",
  "Groups",
  "General",
] as const

export type CommandCategory = (typeof CATEGORY_ORDER)[number]

export type CommandId =
  | "topic.open"
  | "topic.filter"
  | "topic.internal"
  | "topic.sort"
  | "topic.detail"
  | "fetch.latestN"
  | "fetch.offset"
  | "fetch.timestamp"
  | "fetch.beginning"
  | "fetch.reload"
  | "fetch.follow"
  | "fetch.followPause"
  | "fetch.scan"
  | "fetch.scanClose"
  | "fetch.columns"
  | "fetch.sortColumn"
  | "fetch.hideColumn"
  | "filter.open"
  | "filter.js"
  | "filter.cell"
  | "filter.clear"
  | "message.view"
  | "replay.byteExact"
  | "replay.edit"
  | "replay.craft"
  | "replay.copy"
  | "groups.open"
  | "groups.partitions"
  | "groups.members"
  | "groups.onlyTopic"
  | "groups.ephemeral"
  | "groups.sort"
  | "groups.filter"
  | "groups.refresh"
  | "groups.seek"
  | "groups.close"
  | "nav.topics"
  | "nav.picker"
  | "general.help"
  | "general.quit"

export interface Command {
  id: CommandId
  category: CommandCategory
  title: string
  /** The direct binding, shown right-aligned: the palette is a second door that teaches
   *  the first one (spec 021). */
  key: string
  /** Non-null when the command is listed but will refuse, with the reason. The only thing
   *  allowed to be listed and unrunnable is a write the gate blocks — "topiq cannot do
   *  this" is the wrong reading of an absent replay, and spec 019 P1 wants the reason
   *  discoverable. Everything else that cannot act is simply absent. */
  blocked: string | null
}

/** Which view owns the screen. The palette is global, so what it offers depends on it. */
export type PaletteView = "picker" | "topics" | "groups" | "messages"

export interface FocusedColumn {
  path: string
  header: string
  /** Envelope columns (partition/offset/timestamp) cannot be hidden — a row with neither
   *  would have no identity left (spec 024). */
  hideable: boolean
}

/** What the cursor is on. The reducer cannot know this: the rows are derived in the view
 *  from what the broker returned, so the view contributes it (see `registry.ts`). */
export interface CommandFocus {
  /** Topic under the cursor in the topic list. */
  topic: string | null
  /** A message row is focused in the table. */
  message: boolean
  /** Column under the cursor in the table. */
  column: FocusedColumn | null
  /** Group id under the cursor in the group view. */
  group: string | null
}

export const NO_FOCUS: CommandFocus = { topic: null, message: false, column: null, group: null }

/**
 * Everything `buildCommands` is allowed to look at — state, never callbacks. That is the
 * point of the split: the whole state-awareness rule ("a command that cannot act now is
 * absent") is assertable from a plain object, with no renderer and no stubs.
 */
export interface CommandContext {
  view: PaletteView
  topic: string | null
  /** Why a write would be refused on the connected cluster right now, or null (spec 019). */
  writeBlocked: string | null
  filterQuery: string
  follow: MessageFollowState
  scan: MessageScanState | null
  showInternal: boolean
  detailOpen: boolean
  onlyTopic: boolean
  showEphemeral: boolean
  /** Clusters a cross-cluster copy could target (spec 016) — none means no copy command. */
  copyDestinations: number
  focus: CommandFocus
}

/** Behaviour only the on-screen view can perform, because it closes over its own cursor
 *  and its own connections. Registered by the view, called by `runCommand`. */
export interface ViewActions {
  openTopic?: () => void
  openGroups?: () => void
  reload?: () => void
  /** Start, stop or re-run the scan — which one depends on whether the consumer is still
   *  running, and only the view's hook knows that (spec 030). */
  scan?: () => void
  sortColumn?: () => void
  hideColumn?: () => void
  filterCell?: () => void
  /** Seeded from the active JS filter, so reopening edits it rather than starting over —
   *  the seeding rule lives with the filter bar, not in the palette. */
  jsFilter?: () => void
  viewMessage?: () => void
  replay?: () => void
  editReplay?: () => void
  craft?: () => void
  copy?: () => void
  refreshGroups?: () => void
  seekOffsets?: () => void
}
