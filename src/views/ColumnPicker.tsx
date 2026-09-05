import { theme } from "@/theme.ts"

// "Show me these fields, not whatever fits" (spec 024 P2). Inference decides what *can* be
// shown; this decides what is. Borderless, above the filter bar, like every other overlay.

export interface ColumnPickerProps {
  fields: readonly string[]
  hidden: readonly string[]
  cursor: number
}

/** Rows the picker occupies, so the table can give up exactly that many. */
export function columnPickerRows(fieldCount: number): number {
  return 2 + Math.min(fieldCount, MAX_ROWS)
}

const MAX_ROWS = 12

export function ColumnPicker({ fields, hidden, cursor }: ColumnPickerProps) {
  // Scroll the list with the cursor rather than clipping it: a payload with forty fields
  // is exactly when choosing matters.
  const start = Math.max(0, Math.min(cursor - Math.floor(MAX_ROWS / 2), fields.length - MAX_ROWS))
  const shown = fields.slice(Math.max(start, 0), Math.max(start, 0) + MAX_ROWS)
  const width = shown.reduce((max, f) => Math.max(max, f.length), 0)
  return (
    <box flexDirection="column" backgroundColor={theme.panelBg} paddingX={1}>
      <text fg={theme.secondary}>
        columns ({fields.length - hidden.length}/{fields.length} shown)
      </text>
      {shown.map((field, i) => {
        const index = Math.max(start, 0) + i
        const on = !hidden.includes(field)
        return (
          <box key={field} flexDirection="row" gap={1}>
            <text fg={index === cursor ? theme.primary : theme.text}>
              {`${index === cursor ? "▸" : " "} ${on ? "◉" : "○"} ${field.padEnd(width)}`}
            </text>
          </box>
        )
      })}
      <text fg={theme.textDim}>space toggle · a all · enter apply · esc cancel</text>
    </box>
  )
}
