import type { Dispatch } from "react"
import type { AppAction, MessageFilterState } from "@/state.ts"
import { theme } from "@/theme.ts"
import { runtimeErrorLabel } from "./filterBarModel.ts"
import type { FilteredMessages } from "./useFilteredMessages.ts"

// The one-line filter over the loaded window (spec 010), with the JS escape hatch behind
// the `=` prefix (spec 011). Borderless: it reads as an input because it sits on panelBg,
// not because it has a box drawn round it.
//
// The editing surface is OpenTUI's <input>, not hand-rolled key handling: it brings the
// readline bindings people expect (^w delete word, ^u kill line, ^a/^e, word motions,
// undo) which a per-character keymap silently lacks.

export interface FilterBarProps {
  filter: MessageFilterState
  result: FilteredMessages
  dispatch: Dispatch<AppAction>
}

export function FilterBar({ filter, result, dispatch }: FilterBarProps) {
  if (!filter.active && filter.query === "") {
    // Deliberately empty: no permanent keyboard-hint row (spec 022) — "?" is the cheat
    // sheet. The bar carries the filter's state, nothing else.
    return <box />
  }
  const runtime = result.runtimeError
  return (
    <box flexDirection="row" width="100%" gap={2} backgroundColor={theme.panelBg}>
      <text fg={result.mode === "js" ? theme.secondary : theme.primary}>
        {result.mode === "js" ? "js" : "/"}
      </text>
      {filter.active ? (
        <input
          value={filter.query}
          onInput={(query: string) => dispatch({ type: "MSGS_FILTER_SET", query })}
          onSubmit={() => dispatch({ type: "MSGS_FILTER_CLOSE" })}
          placeholder="field:value · = for a JS predicate"
          focused
          flexGrow={1}
          backgroundColor={theme.panelBg}
          textColor={theme.text}
          placeholderColor={theme.textDim}
          cursorColor={theme.primary}
        />
      ) : (
        <>
          <text fg={theme.text}>{filter.query}</text>
          <box flexGrow={1} />
        </>
      )}
      {result.error !== null && <text fg={theme.error}>{result.error}</text>}
      {result.error === null && runtime !== null && (
        <text fg={theme.warning}>{runtimeErrorLabel(runtime)}</text>
      )}
    </box>
  )
}
