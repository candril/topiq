import type { Dispatch } from "react"
import { isProd, type ClusterProfile } from "@/config/schema.ts"
import type { AppAction, CopyState } from "@/state.ts"
import { theme } from "@/theme.ts"
import { windowStart } from "./topicListModel.ts"

// The cross-cluster copy bar (spec 016 P1): pick a destination cluster, then the destination
// topic, and the gate's confirm dialog opens over it. Borderless, at the bottom, drawn only
// while a copy is in progress — an idle bar renders nothing (AGENTS.md).
//
// `copyBarRows` is the one row-count helper: the table subtracts exactly what this draws.
// Two counts would drift and the bar would render past the bottom of the screen, which for
// a write prompt means a keystroke waiting on something nobody can read.

/** Destination rows on screen at once. Past this the list scrolls: a fleet with a dozen
 *  profiles must not eat the message rows the copy is being chosen from. */
export const VISIBLE_DESTINATIONS = 4

export function copyBarRows(copy: CopyState | null, destinations: number): number {
  if (copy === null) {
    // The confirm dialog is an absolute overlay, so it costs the list nothing.
    return 0
  }
  if (copy.planning) {
    return 1
  }
  if (copy.topic === null) {
    return 1 + Math.min(Math.max(destinations, 1), VISIBLE_DESTINATIONS) + 1
  }
  return 2
}

export interface CopyBarProps {
  copy: CopyState
  destinations: readonly ClusterProfile[]
  /** Destination the cursor is on — resolved by the table, which also acts on it. */
  chosen: ClusterProfile | null
  dispatch: Dispatch<AppAction>
  /** Called with the destination topic when the input is submitted. */
  onSubmit: (topic: string) => void
}

export function CopyBar({ copy, destinations, chosen, dispatch, onSubmit }: CopyBarProps) {
  if (copy.planning) {
    return (
      <box flexDirection="row" width="100%" gap={2}>
        <text fg={theme.primary}>copy</text>
        <text fg={theme.textDim}>
          connecting to {chosen?.name ?? "?"} and resolving schemas on both registries…
        </text>
      </box>
    )
  }
  if (copy.topic === null) {
    return <DestinationList copy={copy} destinations={destinations} />
  }
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" width="100%" gap={2}>
        <text fg={theme.primary}>copy to</text>
        <text fg={chosen && isProd(chosen) ? theme.warning : theme.text}>
          {chosen?.name ?? "?"}
        </text>
        {/* onSubmit is cast as in PromptLine: OpenTUI types it as a SubmitEvent handler but
            hands the widget's text to it. */}
        <input
          value={copy.topic}
          onInput={(topic: string) => dispatch({ type: "MSGS_COPY_TOPIC", topic })}
          onSubmit={onSubmit as never}
          focused
          flexGrow={1}
          backgroundColor={theme.bg}
          textColor={theme.text}
          cursorColor={theme.primary}
        />
      </box>
      <text fg={theme.textMuted}>
        the topic as that cluster names it · enter resolves both registries · esc cancels
      </text>
    </box>
  )
}

function DestinationList({
  copy,
  destinations,
}: {
  copy: CopyState
  destinations: readonly ClusterProfile[]
}) {
  const start = windowStart(copy.choice, destinations.length, VISIBLE_DESTINATIONS)
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" width="100%" gap={2}>
        <text fg={theme.primary}>copy</text>
        <text fg={theme.textDim}>
          p{copy.row.partition} @ {copy.row.offset.toString()} to
        </text>
      </box>
      {destinations.length === 0 ? (
        <text fg={theme.error}>no other cluster is configured — a copy needs a second profile</text>
      ) : (
        destinations
          .slice(start, start + VISIBLE_DESTINATIONS)
          .map((profile, i) => (
            <DestinationRow
              key={profile.name}
              profile={profile}
              selected={start + i === copy.choice}
            />
          ))
      )}
      {/* Stated before the dialog, not only in it: the bytes change, and a user who reads
          "copy" and assumes otherwise has been misled (nfr/006 invariant 3). */}
      <text fg={theme.textMuted}>
        not a byte copy: decoded here, re-encoded there · esc cancels
      </text>
    </box>
  )
}

function DestinationRow({ profile, selected }: { profile: ClusterProfile; selected: boolean }) {
  const prod = isProd(profile)
  return (
    <box
      flexDirection="row"
      width="100%"
      gap={2}
      backgroundColor={selected ? theme.panelBg : undefined}
    >
      <text fg={selected ? theme.primary : theme.textDim}>{selected ? "›" : " "}</text>
      <text fg={prod ? theme.warning : selected ? theme.text : theme.textDim}>{profile.name}</text>
      <text fg={prod ? theme.warning : theme.textMuted}>{profile.env ?? (prod ? "prod" : "")}</text>
      <box flexGrow={1} />
      {/* Spec 019 P1: an unwritable destination says so before it is picked, rather than
          refusing after the topic has been typed. */}
      {!profile.allowWrite && <text fg={theme.textMuted}>read-only</text>}
    </box>
  )
}
