import { useEffect } from "react"
import { NO_FOCUS, type CommandFocus, type ViewActions } from "./types.ts"

// How the on-screen view tells the palette what it can do (spec 021).
//
// The palette is global — one overlay, one keymap — but half the commands need the row
// under a cursor the reducer never sees, or a client the view holds. Rather than lifting
// rows and connections into App, the view registers the two things the palette is missing:
// what is focused, and how to act on it. `buildCommands` stays pure over the focus, and
// `runCommand` stays a switch over ids.

export interface ViewCommands {
  focus: CommandFocus
  actions: ViewActions
}

export const NO_VIEW_COMMANDS: ViewCommands = { focus: NO_FOCUS, actions: {} }

export type RegisterViewCommands = (commands: ViewCommands) => void

/**
 * Publish this view's focus and actions for as long as it is mounted.
 *
 * No dependency array on purpose: the object closes over the cursor row, so it is a new one
 * every render and comparing it would cost more than the assignment. The cleanup matters —
 * without it a view that unmounts (ascending a level) leaves its callbacks behind, and the
 * palette would offer commands aimed at a screen that is gone.
 */
export function useViewCommands(register: RegisterViewCommands, commands: ViewCommands): void {
  useEffect(() => {
    register(commands)
    return () => register(NO_VIEW_COMMANDS)
  })
}
