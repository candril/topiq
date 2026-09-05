import { useTerminalDimensions } from "@opentui/react"
import type { Dispatch } from "react"
import { isProd, type ClusterProfile } from "@/config/schema.ts"
import type { AppAction, PickerState } from "@/state.ts"
import { theme } from "@/theme.ts"
import { windowStart } from "./topicListModel.ts"
import { pickerRows, profileAt, profileRows, type PickerRow } from "./clusterPickerModel.ts"
import { useClusterPickerKeys } from "./useClusterPickerKeys.ts"

export interface ClusterPickerProps {
  profiles: ClusterProfile[]
  ui: PickerState
  /** True while an overlay (help) owns the keyboard. */
  suspended: boolean
  dispatch: Dispatch<AppAction>
  onSelect: (profile: ClusterProfile) => void
}

// Rows above/below the list: app header, title line, hint line, status reserve.
const CHROME_ROWS = 4

export function ClusterPicker({ profiles, ui, suspended, dispatch, onSelect }: ClusterPickerProps) {
  const { height } = useTerminalDimensions()
  const rows = pickerRows(profiles)
  const selectableCount = profileRows(rows).length
  const cursor = Math.min(ui.cursor, Math.max(selectableCount - 1, 0))

  useClusterPickerKeys({
    suspended,
    rowCount: selectableCount,
    dispatch,
    onSelect: () => {
      const profile = profileAt(rows, cursor)
      if (profile) {
        onSelect(profile)
      }
    },
  })

  const listHeight = Math.max(3, height - CHROME_ROWS)
  // The cursor indexes profiles, but the window slices display rows — centre on the
  // cursor's display position so headers scroll with their envs.
  const cursorRowIndex = rows.findIndex((r) => r.kind === "profile" && r.index === cursor)
  const start = windowStart(Math.max(cursorRowIndex, 0), rows.length, listHeight)

  return (
    <box flexDirection="column" flexGrow={1} paddingX={1}>
      <text fg={theme.secondary}>select a cluster</text>
      <box flexDirection="column" height={listHeight} marginTop={1}>
        {profiles.length === 0 && (
          <text fg={theme.textDim}>no clusters configured — see config.example.toml</text>
        )}
        {rows.slice(start, start + listHeight).map((row) => (
          <Row key={rowKey(row)} row={row} selected={isCursorRow(row, cursor)} />
        ))}
      </box>
    </box>
  )
}

function rowKey(row: PickerRow): string {
  return row.kind === "header" ? `#${row.label}` : row.profile.name
}

function isCursorRow(row: PickerRow, cursor: number): boolean {
  return row.kind === "profile" && row.index === cursor
}

function Row({ row, selected }: { row: PickerRow; selected: boolean }) {
  if (row.kind === "header") {
    return (
      <box flexDirection="row" width="100%">
        <text fg={theme.secondary}>{row.label}</text>
      </box>
    )
  }
  const { profile } = row
  const grouped = profile.group !== undefined
  // Declared prod only (spec 023): isProd reads `prod = true` / `env = "prod"`, never
  // hostname heuristics. Warning colour wins over selection colour so the row is
  // unmistakable even under the cursor — selection still shows via the background.
  const prod = isProd(profile)
  const labelFg = prod ? theme.warning : selected ? theme.primary : theme.text
  return (
    <box
      flexDirection="row"
      width="100%"
      gap={2}
      backgroundColor={selected ? theme.panelBg : undefined}
    >
      <text fg={labelFg}>{(grouped ? `  ${row.label}` : row.label).padEnd(24)}</text>
      {grouped ? (
        <text fg={theme.textDim}>{profile.name}</text>
      ) : (
        profile.env !== undefined && (
          <text fg={prod ? theme.warning : theme.textDim}>{profile.env}</text>
        )
      )}
      <box flexGrow={1} />
      <text fg={profile.allowWrite ? theme.warning : theme.textDim}>
        {profile.allowWrite ? "write" : "read-only"}
      </text>
    </box>
  )
}
