import type { TextareaRenderable } from "@opentui/core"
import { useCallback } from "react"
import { compileJs } from "@/filter/js.ts"
import { theme } from "@/theme.ts"

// The JS escape hatch as a multi-line box (spec 011), the shape people know from Redpanda
// Console: an expression over key/value/headers/partitionID/offset/timestamp.
//
// The editing surface is OpenTUI's <textarea>, so the whole readline/editor action set
// comes for free — ^w delete word, ^u kill to line start, word motions, undo/redo,
// selection. Hand-rolled key handling silently lacks all of it.
//
// It is imperative by design (monq hit the same seam): seeded once via initialValue and
// read back through onContentChange, because a controlled value prop would fight the
// buffer's own cursor.

export interface JsFilterEditorProps {
  source: string
  onChange: (source: string) => void
}

const PLACEHOLDER = 'value.Status === "active" && key > 717197000n'
const ROWS = 4

/** Rows the box occupies. The table subtracts these from the row list, so the two must
 *  agree — hence one function rather than a constant guessed at each end. */
export function jsEditorRows(source: string): number {
  const error = source.trim() === "" ? null : compileJs(source).error
  return 2 + ROWS + (error === null ? 0 : 1)
}

export function JsFilterEditor({ source, onChange }: JsFilterEditorProps) {
  const error = source.trim() === "" ? null : compileJs(source).error
  // Enter inserts a newline here rather than submitting: this is an editor, and ^s is the
  // one key that applies (spec 011).
  const attach = useCallback(
    (node: TextareaRenderable | null) => {
      if (node) {
        node.onContentChange = () => onChange(node.plainText)
      }
    },
    [onChange],
  )
  return (
    <box flexDirection="column" backgroundColor={theme.panelBg} paddingX={1}>
      <box flexDirection="row" gap={2}>
        <text fg={theme.secondary}>js filter</text>
        <text fg={theme.textDim}>key · value · headers · partitionID · offset · timestamp</text>
      </box>
      <textarea
        ref={attach}
        initialValue={source}
        placeholder={PLACEHOLDER}
        focused
        height={ROWS}
        keyBindings={[{ name: "return", action: "newline" }]}
        backgroundColor={theme.panelBg}
        textColor={theme.text}
        placeholderColor={theme.textDim}
      />
      {error !== null && <text fg={theme.error}>{error}</text>}
      <text fg={theme.textDim}>^s apply · enter newline · esc cancel</text>
    </box>
  )
}
