import { theme } from "@/theme.ts"
import type { Suggestion } from "@/filter/suggest.ts"

// Sits directly above the filter bar (which is pinned to the bottom, AGENTS.md), so the
// list grows towards the content it is filtering — monq's arrangement.

export interface FilterSuggestionsProps {
  suggestions: readonly Suggestion[]
  selected: number
}

export function FilterSuggestions({ suggestions, selected }: FilterSuggestionsProps) {
  if (suggestions.length === 0) {
    return <box />
  }
  const width = suggestions.reduce((max, s) => Math.max(max, s.label.length), 0)
  return (
    <box flexDirection="column" backgroundColor={theme.panelBg} paddingX={1}>
      {suggestions.map((s, i) => (
        <box key={s.term} flexDirection="row" gap={2}>
          <text fg={i === selected ? theme.primary : theme.text}>
            {(i === selected ? "▸ " : "  ") + s.label.padEnd(width)}
          </text>
          {s.hint !== undefined && <text fg={theme.textDim}>{s.hint}</text>}
        </box>
      ))}
      <text fg={theme.textDim}>^y accept · ^n/^p move · enter apply</text>
    </box>
  )
}
