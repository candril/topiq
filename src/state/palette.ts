import type { PaletteState, SubReducer } from "./types.ts"

// Command-palette state (spec 021). In the app reducer rather than component state for the
// same reason every other overlay is: App's global keymap has to see that the palette owns
// the keyboard, or `q` would quit out from under a half-typed query.

export function openPaletteState(): PaletteState {
  // Every open starts with an empty query — a stale one from last time would hide the
  // command you opened the palette to find.
  return { query: "", cursor: 0 }
}

export const paletteReducer: SubReducer = (state, action) => {
  switch (action.type) {
    case "PALETTE_OPEN":
      return { ...state, palette: openPaletteState() }
    case "PALETTE_CLOSE":
      return { ...state, palette: null }
    case "PALETTE_SET":
      // The highlight goes back to the top: it pointed at a row in the old match list, and
      // enter must never run a command the query no longer describes.
      return state.palette === null
        ? state
        : { ...state, palette: { query: action.query, cursor: 0 } }
    case "PALETTE_MOVE": {
      if (state.palette === null) {
        return state
      }
      const last = Math.max(action.rowCount - 1, 0)
      const cursor = Math.max(0, Math.min(state.palette.cursor + action.delta, last))
      return { ...state, palette: { ...state.palette, cursor } }
    }
    default:
      return null
  }
}
