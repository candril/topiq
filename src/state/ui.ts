import type { SubReducer } from "./types.ts"

// Overlay and status-line state (specs 001, 022).

export const uiReducer: SubReducer = (state, action) => {
  switch (action.type) {
    case "OPEN_HELP":
      return { ...state, helpOpen: true }
    case "CLOSE_HELP":
      return { ...state, helpOpen: false }
    case "SHOW_STATUS":
      return { ...state, status: { message: action.message, kind: action.kind ?? "info" } }
    case "CLEAR_STATUS":
      return { ...state, status: null }
    default:
      return null
  }
}
