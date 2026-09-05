import { CATEGORY_ORDER, type Command, type CommandCategory } from "@/commands/types.ts"
import { windowStart } from "./topicListModel.ts"

// Layout model for the palette overlay (spec 021): sections, and how many rows of them fit.
// Pure, so the geometry is testable without a renderer — and so the row count has exactly
// one definition. The overlay is absolutely positioned, so unlike the bars it takes no rows
// from the list underneath (AGENTS.md); what it must not outgrow is the terminal itself,
// and `paletteCapacity` is the single helper that decides that for both the window and the
// box it is drawn in.

export type PaletteEntry =
  | { kind: "header"; category: CommandCategory }
  /** `index` is the position in the *match* list — what the cursor counts. Headers are not
   *  selectable, so they are numbered by nothing. */
  | { kind: "command"; command: Command; index: number }

/** Rows the box draws besides its entries: the query field, its hint, and the slot the
 *  highlighted command's refusal is written into (spec 019 P1). Reserved even when empty,
 *  so the box does not resize as the highlight moves. */
export const PALETTE_CHROME = 3

/** Never taller than this, however big the terminal: a palette that fills the screen hides
 *  the view you are choosing a command for. */
const MAX_ENTRIES = 14

/** Rows left to the app around the overlay: header, status line, and margin. */
const SCREEN_RESERVE = 6

/** Group the matches into the fixed sections, dropping the empty ones. */
export function paletteEntries(matches: readonly Command[]): PaletteEntry[] {
  const entries: PaletteEntry[] = []
  for (const category of CATEGORY_ORDER) {
    const inSection = matches
      .map((command, index) => ({ command, index }))
      .filter((row) => row.command.category === category)
    if (inSection.length === 0) {
      continue
    }
    entries.push({ kind: "header", category })
    for (const row of inSection) {
      entries.push({ kind: "command", command: row.command, index: row.index })
    }
  }
  return entries
}

/** Entry rows the overlay may draw at this terminal height. At least one: a one-row palette
 *  still shows the command enter would run. */
export function paletteCapacity(terminalHeight: number): number {
  return Math.max(1, Math.min(MAX_ENTRIES, terminalHeight - SCREEN_RESERVE - PALETTE_CHROME))
}

/** Total height of the overlay box, entries plus chrome — one helper, so what is drawn and
 *  what was budgeted cannot drift. */
export function paletteRows(entryCount: number, terminalHeight: number): number {
  return Math.min(entryCount, paletteCapacity(terminalHeight)) + PALETTE_CHROME
}

/** The visible slice, scrolled to keep the highlighted command on screen. */
export function paletteWindow(
  entries: readonly PaletteEntry[],
  cursor: number,
  capacity: number,
): PaletteEntry[] {
  const at = entries.findIndex((entry) => entry.kind === "command" && entry.index === cursor)
  const start = windowStart(Math.max(at, 0), entries.length, capacity)
  // Keep a section label with the first row under it: a scrolled list whose top row is a
  // command with its own header just out of view says nothing about which section it is in.
  // Only when the header is *immediately* above — shifting further would push the row the
  // cursor is on off the bottom, which is the one row that must be visible.
  const shifted = start > 0 && entries[start - 1]?.kind === "header" ? start - 1 : start
  // …and never at the cost of the highlighted row itself: at the end of a scrolled list the
  // shift would push it out, and a cursor you cannot see is worse than a missing label.
  const adjusted = at < shifted + capacity ? shifted : start
  return entries.slice(adjusted, adjusted + capacity)
}
