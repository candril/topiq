import { useKeyboard } from "@opentui/react"
import type { Dispatch } from "react"
import { halfPage, levelNav, listNav, normalizeKey, pageNav } from "@/keys.ts"
import type { AppAction } from "@/state.ts"

// Picker key handling as a hook, not inline in the component (spec 020): the view stays
// presentational and the binding logic is visible in one place. q/?/Ctrl+C stay with
// App's global keymap.

export interface ClusterPickerKeyOptions {
  /** True while an overlay (help) owns the keyboard — every key is ignored here. */
  suspended: boolean
  rowCount: number
  dispatch: Dispatch<AppAction>
  onSelect: () => void
}

export function useClusterPickerKeys({
  suspended,
  rowCount,
  dispatch,
  onSelect,
}: ClusterPickerKeyOptions): void {
  useKeyboard((key) => {
    if (suspended) {
      return
    }
    const k = normalizeKey(key)
    // ctrlPrev: false — `^p` belongs to the command palette in a base view (spec 021).
    const nav = listNav(k, { ctrlPrev: false })
    if (nav) {
      return dispatch({ type: "PICKER_MOVE", delta: nav === "next" ? 1 : -1, rowCount })
    }
    const page = pageNav(k)
    if (page) {
      // The picker draws every profile, so "half a page" is half the list.
      const delta = halfPage(rowCount)
      return dispatch({ type: "PICKER_MOVE", delta: page === "down" ? delta : -delta, rowCount })
    }
    // `l`/→ descend like enter. Ascend is App's (spec 020) and is a no-op here — the
    // picker is the root view.
    if (levelNav(k) === "descend") {
      return onSelect()
    }
    switch (k.name) {
      case "g":
        return dispatch({ type: "PICKER_JUMP", to: k.shift ? "bottom" : "top", rowCount })
      case "return":
      case "enter":
        return onSelect()
    }
  })
}
