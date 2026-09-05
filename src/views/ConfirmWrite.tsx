import type { ConfirmPrompt } from "@/safety/gate.ts"
import { theme } from "@/theme.ts"

// The one confirm dialog for every write (spec 019 P1). It renders a ConfirmPrompt and
// nothing else: what a write is called, where it lands and what it costs are decided in
// src/safety/gate.ts, so two write paths cannot describe the same danger differently.
//
// Centred and absolutely positioned like HelpPanel, deliberately not a bottom bar: it is
// modal, and being out of the flow means no list has to reserve rows for it — an overlay
// pushed off the bottom of the screen is invisible, which for this dialog would mean a
// keystroke waiting on something the user cannot read.
//
// Keys belong to the owning view via confirmResponse(): the confirm keystroke is part of
// the gate, not of the presentation.

export interface ConfirmWriteProps {
  /** What has been retyped so far; ignored unless the prompt demands it. */
  typed?: string
  onTyped?: (typed: string) => void
  prompt: ConfirmPrompt
}

const LABEL_WIDTH = 11

export function ConfirmWrite({ prompt, typed, onTyped }: ConfirmWriteProps) {
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
      zIndex={200}
    >
      <box flexDirection="column" backgroundColor={theme.modalBg} paddingX={3} paddingY={1}>
        <text fg={prompt.prod ? theme.warning : theme.text}>
          <strong>{prompt.title}</strong>
        </text>
        <box flexDirection="column" marginTop={1}>
          {/* Keyed by position: a seek's per-partition offset lines share one blank label
              (spec 018), so the label alone is not unique. */}
          {prompt.lines.map((line, i) => (
            <box key={`${i}-${line.label}`} flexDirection="row">
              <text fg={theme.textDim}>{line.label.padEnd(LABEL_WIDTH)}</text>
              <text fg={line.tone === "warn" ? theme.warning : theme.text}>{line.value}</text>
            </box>
          ))}
        </box>
        <box flexDirection="column" marginTop={1}>
          {prompt.warnings.map((warning) => (
            <text key={warning} fg={theme.warning}>
              {`! ${warning}`}
            </text>
          ))}
        </box>
        <box marginTop={1}>
          {prompt.typeToConfirm !== null && (
            <box flexDirection="row" gap={1}>
              <text fg={theme.warning}>retype {prompt.typeToConfirm}:</text>
              <input
                value={typed ?? ""}
                onInput={(next: string) => onTyped?.(next)}
                focused
                flexGrow={1}
                backgroundColor={theme.modalBg}
                textColor={theme.text}
                cursorColor={theme.warning}
              />
            </box>
          )}
          <text fg={theme.primary}>{prompt.hint}</text>
        </box>
      </box>
    </box>
  )
}
