import type { ReactNode } from "react"
import { formatLag } from "@/kafka/groups.ts"
import { theme } from "@/theme.ts"
import type { GroupMemberMeta, PartitionOffset } from "@/types.ts"

// The two bottom panes of the group view (spec 017): per-partition offsets/lag (P1) and
// who is assigned what (P2). Borderless — depth is panelBg plus padding.
//
// `groupPaneHeight` is the one row-count helper: the list subtracts it and the pane is
// drawn with `groupPaneRows` from the same numbers. Two independent counts would drift and
// the pane would silently render below the bottom of the screen (AGENTS.md).

const PANE_MAX_ROWS = 8
/** Rows the pane spends on itself: its header plus one padding row top and bottom. */
export const PANE_CHROME_ROWS = 3

/** Item rows the pane shows at once. Never zero: a one-row pane still states how many
 *  items are hidden. */
export function groupPaneRows(itemCount: number, available: number): number {
  return Math.max(1, Math.min(itemCount, PANE_MAX_ROWS, available))
}

/** Total height the pane takes from the list. */
export function groupPaneHeight(itemCount: number, available: number): number {
  return groupPaneRows(itemCount, available) + PANE_CHROME_ROWS
}

/** "partitions 9–16 of 64" — the hidden ones are stated, not silently cut off (nfr/004). */
export function paneRangeLabel(start: number, shown: number, total: number, noun: string): string {
  if (shown >= total) {
    return `${total} ${noun}`
  }
  return `${noun} ${start + 1}–${start + shown} of ${total}`
}

function PaneFrame({
  title,
  label,
  scrollable,
  children,
}: {
  title: string
  label: string
  scrollable: boolean
  children: ReactNode
}) {
  return (
    <box flexDirection="column" backgroundColor={theme.panelBg} paddingX={2} paddingY={1}>
      <box flexDirection="row" gap={2}>
        <text fg={theme.secondary}>{title}</text>
        <text fg={theme.textDim}>{label}</text>
        {scrollable && <text fg={theme.textMuted}>J/K scroll</text>}
      </box>
      {children}
    </box>
  )
}

export function GroupOffsetsPane({
  groupId,
  offsets,
  offset,
  rows,
}: {
  groupId: string
  offsets: readonly PartitionOffset[]
  offset: number
  rows: number
}) {
  const shown = offsets.slice(offset, offset + rows)
  return (
    <PaneFrame
      title={groupId}
      label={paneRangeLabel(offset, shown.length, offsets.length, "partitions")}
      scrollable={offsets.length > rows}
    >
      {offsets.length === 0 && <text fg={theme.textDim}>no partitions</text>}
      {shown.map((p) => (
        <box key={p.partition} flexDirection="row" gap={2}>
          <text fg={theme.text}>{`p${p.partition}`.padEnd(5)}</text>
          <text fg={theme.textDim}>
            committed {p.committed === null ? "—" : p.committed.toString()}
          </text>
          <text fg={theme.textDim}>high {p.high.toString()}</text>
          {/* Undefined lag is dimmed, never coloured: "—" is an absence, not a verdict. */}
          <text fg={p.lag === null ? theme.textMuted : lagColour(p.lag)}>
            lag {formatLag(p.lag)}
          </text>
        </box>
      ))}
    </PaneFrame>
  )
}

function lagColour(lag: bigint): string {
  return lag === 0n ? theme.success : theme.warning
}

export function GroupMembersPane({
  groupId,
  members,
  offset,
  rows,
}: {
  groupId: string
  members: readonly GroupMemberMeta[]
  offset: number
  rows: number
}) {
  const shown = members.slice(offset, offset + rows)
  const idWidth = Math.max(8, ...members.map((m) => m.clientId.length))
  return (
    <PaneFrame
      title={groupId}
      label={paneRangeLabel(offset, shown.length, members.length, "members")}
      scrollable={members.length > rows}
    >
      {members.length === 0 && (
        <text fg={theme.textDim}>no members — the group is not running</text>
      )}
      {shown.map((m) => (
        <box key={m.memberId} flexDirection="row" gap={2}>
          <text fg={theme.text}>{m.clientId.padEnd(idWidth)}</text>
          <text fg={theme.textDim}>{m.clientHost}</text>
          <text fg={theme.textDim}>{assignmentLabel(m.partitions)}</text>
        </box>
      ))}
    </PaneFrame>
  )
}

// Past this the assignment is stated as a count plus a sample: a 64-partition member would
// otherwise run off the row and the count is the part that answers "who owns most".
const ASSIGNMENT_SAMPLE = 10

/** A member with nothing here holds no partition *of this topic* — it may well own others,
 *  so the label says "none on this topic" rather than implying the member is idle. */
export function assignmentLabel(partitions: readonly number[]): string {
  if (partitions.length === 0) {
    return "none on this topic"
  }
  const sorted = [...partitions].sort((a, b) => a - b)
  const listed = sorted.slice(0, ASSIGNMENT_SAMPLE)
  const label = `p${listed.join(" p")}`
  return sorted.length > listed.length
    ? `${sorted.length} partitions: ${label} +${sorted.length - listed.length} more`
    : label
}
