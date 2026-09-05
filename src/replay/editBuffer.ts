import { stringify, stringifyEditable } from "@/render/json.ts"
import { parseJsonLossless } from "@/schema/jsonFallback.ts"
import type { DecodedMessage } from "@/types.ts"
import { headerDisplay, metadataHeader } from "@/views/messageDoc.ts"

// The $EDITOR buffer for spec 014, and its reader. Pure, so the whole round trip is testable
// without spawning an editor.
//
// P1 edits the value only: the key and the headers are shown as comments and re-produced as
// their original bytes. They are context, not content — an editable key in the same buffer
// is P2, and until then a comment cannot be mistaken for something the save will apply.

const BODY_RULES = [
  "//",
  "// Edit the value below, save and quit. Everything after this comment block must be",
  "// valid JSON — comments are only stripped from the top of the file.",
  "// Integers are bare literals: which ones are int64 is read back from the schema, so",
  "// nothing has to be quoted to stay exact.",
  '// Byte fields are full hex in a string ("0x1f8b…"); that form is read back as bytes.',
  "// Saving the buffer unchanged produces nothing.",
]

/** The editable document: metadata and the untouched parts as comments, then the decoded
 *  value as parseable JSON. */
export function editBuffer(row: DecodedMessage, now: Date): string {
  const head = [
    "// topiq — edit and replay",
    ...metadataHeader(row, now),
    `// key       ${stringify(row.decodedKey)} (re-produced as its original bytes)`,
    ...headerComments(row),
    ...BODY_RULES,
  ]
  return `${head.join("\n")}\n${stringifyEditable(row.decodedValue)}\n`
}

function headerComments(row: DecodedMessage): string[] {
  const entries = Object.entries(row.headers)
  if (entries.length === 0) {
    return ["// headers   none"]
  }
  return entries.map(
    ([name, bytes], i) =>
      `// ${(i === 0 ? "headers" : "").padEnd(9)} ${name}=${headerDisplay(bytes)}`,
  )
}

const COMMENT_OR_BLANK = /^\s*(\/\/.*)?$/

/**
 * Read the saved buffer back. Leading `//` lines are stripped — only leading ones, because a
 * `//` inside a string is data and a general comment stripper would corrupt it.
 *
 * Integer literals too large for a Number come back as BigInt here (nfr/006); the rest of
 * the BigInt decision is made against the schema, in src/schema/coerce.ts.
 *
 * Throws on invalid JSON: the caller reports the parser's own message, which names the
 * offending position.
 */
export function parseEditBuffer(text: string): unknown {
  return parseJsonLossless(stripLeadingComments(text))
}

export function stripLeadingComments(text: string): string {
  const lines = text.split("\n")
  let start = 0
  while (start < lines.length && COMMENT_OR_BLANK.test(lines[start]!)) {
    start += 1
  }
  return lines.slice(start).join("\n")
}

/** True when the buffer holds nothing but the comment header — a save that deleted the
 *  body, or an editor opened and quit on an empty file. */
export function isEmptyBuffer(text: string): boolean {
  return stripLeadingComments(text).trim() === ""
}
