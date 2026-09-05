import { useTerminalDimensions } from "@opentui/react"
import type { Dispatch } from "react"
import type { Command } from "@/commands/types.ts"
import type { AppAction, PaletteState } from "@/state.ts"
import { theme } from "@/theme.ts"
import {
  paletteCapacity,
  paletteEntries,
  paletteWindow,
  type PaletteEntry,
} from "./commandPaletteModel.ts"

// The `Ctrl+P` overlay (spec 021 P1): the matching commands in fixed sections, each showing
// the direct key that would have run it, over the query field.
//
// Centred and absolutely positioned like the confirm dialog and the help panel — modal, and
// out of the flow, so no list has to reserve rows for it (AGENTS.md). Borderless: depth is
// modalBg plus padding. The query field is the last child, as every input in this app is.

export interface CommandPaletteProps {
  ui: PaletteState
  /** Already filtered and ranked — the palette renders what `matchCommands` returned. */
  matches: readonly Command[]
  dispatch: Dispatch<AppAction>
  onRun: (command: Command) => void
}

const MAX_WIDTH = 78
const MIN_WIDTH = 36

export function CommandPalette({ ui, matches, dispatch, onRun }: CommandPaletteProps) {
  const { width, height } = useTerminalDimensions()
  const cursor = Math.min(ui.cursor, Math.max(matches.length - 1, 0))
  const highlighted = matches[cursor]
  const shown = paletteWindow(paletteEntries(matches), cursor, paletteCapacity(height))
  const boxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width - 8))
  const keyWidth = shown.reduce(
    (max, entry) => (entry.kind === "command" ? Math.max(max, entry.command.key.length) : max),
    0,
  )
  const run = () => {
    if (highlighted !== undefined) {
      onRun(highlighted)
    }
  }
  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      // Opaque on purpose: a transparent overlay lets the table bleed through and leaves
      // stale cells behind when it closes, which reads as a corrupted screen.
      backgroundColor={theme.bg}
      justifyContent="center"
      alignItems="center"
      zIndex={150}
    >
      <box
        flexDirection="column"
        width={boxWidth}
        backgroundColor={theme.modalBg}
        paddingX={2}
        paddingY={1}
      >
        {matches.length === 0 ? (
          <text fg={theme.textDim}>no command matches</text>
        ) : (
          shown.map((entry) => (
            <EntryRow
              key={entry.kind === "header" ? `section:${entry.category}` : entry.command.id}
              entry={entry}
              cursor={cursor}
              keyWidth={keyWidth}
            />
          ))
        )}
        {/* Spec 019 P1: a write the gate blocks stays listed and says why, rather than
            quietly not being there — an absent replay reads as "topiq cannot replay". */}
        <text fg={theme.warning}>
          {highlighted?.blocked ? fit(highlighted.blocked, boxWidth - 4) : ""}
        </text>
        <box flexDirection="row" width="100%" gap={1} marginTop={1}>
          <text fg={theme.primary}>›</text>
          {/* onSubmit is cast as in PromptLine: OpenTUI types it as a SubmitEvent handler
              but hands the widget's text to it — the palette runs the highlighted command,
              not the text, so the argument is ignored. */}
          <input
            value={ui.query}
            onInput={(query: string) => dispatch({ type: "PALETTE_SET", query })}
            onSubmit={run as never}
            focused
            flexGrow={1}
            backgroundColor={theme.modalBg}
            textColor={theme.text}
            cursorColor={theme.primary}
          />
        </box>
        <text fg={theme.textMuted}>enter runs · ^n/^p move · esc closes</text>
      </box>
    </box>
  )
}

function EntryRow({
  entry,
  cursor,
  keyWidth,
}: {
  entry: PaletteEntry
  cursor: number
  keyWidth: number
}) {
  if (entry.kind === "header") {
    return <text fg={theme.secondary}>{entry.category}</text>
  }
  const { command } = entry
  const selected = entry.index === cursor
  const blocked = command.blocked !== null
  return (
    <box
      flexDirection="row"
      width="100%"
      gap={1}
      backgroundColor={selected ? theme.panelBg : undefined}
    >
      <text fg={selected ? theme.primary : theme.textDim}>{selected ? "›" : " "}</text>
      <text fg={blocked ? theme.textDim : theme.text}>{command.title}</text>
      <box flexGrow={1} />
      {blocked && <text fg={theme.warning}>blocked</text>}
      {/* The direct key, right-aligned: the palette teaches the binding while you use it. */}
      <text fg={theme.secondary}>{command.key.padStart(keyWidth)}</text>
    </box>
  )
}

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(width - 1, 0))}…` : text
}
