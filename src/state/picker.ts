import type { PickerState, SubReducer } from "./types.ts"

// Cluster-picker cursor (specs 002, 023). Lives in the app reducer, not the component,
// so the position survives descending into a cluster and ascending back out.

export function initialPickerState(): PickerState {
  return { cursor: 0 }
}

function clamp(cursor: number, rowCount: number): number {
  return Math.max(0, Math.min(cursor, rowCount - 1))
}

export const pickerReducer: SubReducer = (state, action) => {
  switch (action.type) {
    case "PICKER_MOVE":
      return {
        ...state,
        picker: { cursor: clamp(state.picker.cursor + action.delta, action.rowCount) },
      }
    case "PICKER_JUMP":
      return {
        ...state,
        picker: {
          cursor: action.to === "top" ? 0 : clamp(action.rowCount - 1, action.rowCount),
        },
      }
    default:
      return null
  }
}
