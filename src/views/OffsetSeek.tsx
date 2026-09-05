import type { Dispatch } from "react"
import { SEEK_TARGETS } from "@/seek/model.ts"
import type { AppAction, GroupSeekState } from "@/state.ts"
import { theme } from "@/theme.ts"

// The offset-seek bar (spec 018 P1): pick a target, type a value if it needs one, then the
// gate's confirm dialog opens over it. Borderless, at the bottom, and drawn only while a
// seek is in progress — an idle bar renders nothing (AGENTS.md).
//
// `seekBarRows` is the one row-count helper: the group list subtracts exactly what this
// draws. Two counts would drift and the bar would render below the bottom of the screen,
// which for a write prompt means a keystroke waiting on something nobody can read.

export function seekBarRows(seek: GroupSeekState | null): number {
  if (seek === null || seek.pending !== null) {
    // The confirm dialog is an absolute overlay, so it costs the list nothing.
    return 0
  }
  return seek.planning ? 1 : 2
}

export interface OffsetSeekBarProps {
  seek: GroupSeekState
  topic: string
  dispatch: Dispatch<AppAction>
  /** Called with the typed value when the input is submitted. */
  onSubmit: (value: string) => void
}

export function OffsetSeekBar({ seek, topic, dispatch, onSubmit }: OffsetSeekBarProps) {
  const target = SEEK_TARGETS[Math.min(seek.choice, SEEK_TARGETS.length - 1)]
  if (seek.pending !== null) {
    return null
  }
  if (seek.planning) {
    return (
      <box flexDirection="row" width="100%" gap={2}>
        <text fg={theme.primary}>seek</text>
        <text fg={theme.textDim}>
          reading {seek.groupId} on {topic}…
        </text>
      </box>
    )
  }
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" width="100%" gap={2}>
        <text fg={theme.primary}>seek</text>
        <text fg={theme.text}>{seek.groupId}</text>
        <text fg={theme.textDim}>to</text>
        {SEEK_TARGETS.map((t) => (
          <text key={t.kind} fg={t.kind === target?.kind ? theme.primary : theme.textMuted}>
            {t.kind === target?.kind ? `[${t.label}]` : ` ${t.label} `}
          </text>
        ))}
      </box>
      {seek.value === null ? (
        // Stated up front, not after a broker error: the group has to be empty, and getting
        // it there is a deployment step topiq does not take (spec 018).
        <text fg={theme.textMuted}>
          the group must be Empty · scaling the consumer down and up stays manual · esc cancels
        </text>
      ) : (
        <box flexDirection="row" width="100%" gap={2}>
          <text fg={theme.secondary}>{target?.label ?? ""}</text>
          {/* onSubmit is cast as in PromptLine: OpenTUI types it as a SubmitEvent handler
              but hands the widget's text to it. */}
          <input
            value={seek.value}
            onInput={(value: string) => dispatch({ type: "GROUPS_SEEK_TYPE", value })}
            onSubmit={onSubmit as never}
            placeholder={target?.placeholder ?? ""}
            focused
            flexGrow={1}
            backgroundColor={theme.bg}
            textColor={theme.text}
            placeholderColor={theme.textDim}
            cursorColor={theme.primary}
          />
        </box>
      )}
    </box>
  )
}
