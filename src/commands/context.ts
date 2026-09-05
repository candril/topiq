import type { ClusterProfile } from "@/config/schema.ts"
import { writeBlockedReason } from "@/safety/gate.ts"
import type { AppState } from "@/state.ts"
import type { CommandContext, CommandFocus, PaletteView } from "./types.ts"

// The bridge from app state to the palette's context, plus the one predicate that decides
// whether the `^p` chord is free (spec 021 precedence rule). Both pure, so the precedence
// is a table of cases in a test rather than a cascade of guards nobody can enumerate.

/** Which view owns the screen, from state alone. Mirrors App's render branch — an unusable
 *  session (picked but not connected) is still the picker, so it offers picker commands. */
export function currentView(state: AppState, profile: ClusterProfile | null): PaletteView {
  if (state.cluster === null || profile === null) {
    return "picker"
  }
  if (state.groups.topic !== null) {
    return "groups"
  }
  return state.topic === null ? "topics" : "messages"
}

export interface CommandContextInput {
  state: AppState
  /** The connected cluster, or null before one is. What writes are gated on (spec 019). */
  profile: ClusterProfile | null
  /** Contributed by the on-screen view: the reducer holds cursor *indices*, not the rows
   *  the broker returned, so what the cursor is on can only come from the view. */
  focus: CommandFocus
  /** How many clusters a copy could be aimed at (spec 016). */
  copyDestinations: number
}

export function commandContext(input: CommandContextInput): CommandContext {
  const { state, profile, focus, copyDestinations } = input
  return {
    view: currentView(state, profile),
    topic: state.topic,
    writeBlocked: writeBlockedReason(profile),
    filterQuery: state.messages.filter.query,
    follow: state.messages.follow,
    showInternal: state.topics.showInternal,
    detailOpen: state.topics.detailOpen,
    onlyTopic: state.groups.onlyTopic,
    showEphemeral: state.groups.showEphemeral,
    copyDestinations,
    focus,
  }
}

/**
 * True while a list, menu, modal or text field owns the keyboard. There `^p` means
 * "previous" and the palette stands down (specs 020, 021); everywhere else the chord is
 * the palette's.
 *
 * The base views are deliberately *not* owners: they are where the palette is reached
 * from, and they give `^p` up for it (see `listNav`'s `ctrlPrev`).
 */
export function keyboardOwned(state: AppState): boolean {
  if (state.helpOpen || state.palette !== null) {
    return true
  }
  if (state.cluster === null) {
    // The picker has no text field and no sub-list; `^p` is the palette's there.
    return false
  }
  // Same precedence App renders in: the group view sits over the topic the table would
  // have shown, so its captures are the ones that count.
  if (state.groups.topic !== null) {
    return state.groups.filterActive || state.groups.seek !== null
  }
  if (state.topic !== null) {
    const m = state.messages
    return (
      m.prompt !== null ||
      m.filter.active ||
      m.jsEditor !== null ||
      m.columnPicker !== null ||
      m.confirm !== null ||
      m.copy !== null
    )
  }
  return state.topics.filterActive
}
