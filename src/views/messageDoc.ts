import { stringifyPretty } from "@/render/json.ts"
import { relativeAge } from "@/time.ts"
import { formatTimestamp } from "@/table/window.ts"
import type { DecodedMessage } from "@/types.ts"

// The message as an $EDITOR document (spec 008 as amended): Enter on a table row opens
// this directly — there is no intermediate detail pane. Pure so it tests without a
// renderer.

/** Headers are bytes with no schema: show UTF-8 when it decodes cleanly and has no
 *  control characters (a stray \n would break the line layout), hex otherwise. */
export function headerDisplay(bytes: Buffer): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    // oxlint-disable-next-line no-control-regex -- matching control chars is the point
    if (!/[\u0000-\u001f\u007f]/.test(text)) {
      return text
    }
  } catch {
    // fall through to hex
  }
  return `0x${bytes.toString("hex")}`
}

const DUMP_ROW_BYTES = 16
const DUMP_MAX_BYTES = 512

/** Classic offset/hex/ascii dump for undecodable payloads, capped — a corrupt 10 MB blob
 *  must not become 600k lines. */
export function hexDump(buf: Buffer, maxBytes: number = DUMP_MAX_BYTES): string[] {
  const lines: string[] = []
  const shown = Math.min(buf.length, maxBytes)
  for (let i = 0; i < shown; i += DUMP_ROW_BYTES) {
    const chunk = buf.subarray(i, Math.min(i + DUMP_ROW_BYTES, shown))
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ")
    const ascii = [...chunk]
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
      .join("")
    lines.push(
      `${i.toString(16).padStart(8, "0")}  ${hex.padEnd(DUMP_ROW_BYTES * 3 - 1)}  |${ascii}|`,
    )
  }
  if (buf.length > maxBytes) {
    lines.push(`… ${buf.length - maxBytes} more bytes`)
  }
  return lines
}

/** Where the message came from, as `//` comment lines. Shared with spec 014's editable
 *  buffer so the two documents describe a message identically. */
export function metadataHeader(row: DecodedMessage, now: Date): string[] {
  return [
    `// topic     ${row.topic}`,
    `// partition p${row.partition} · offset ${row.offset}`,
    `// timestamp ${formatTimestamp(row.timestamp)} UTC · ${relativeAge(row.timestamp, now)}`,
    `// schema    ${schemaSummary(row)}`,
    `// size      ${sizeSummary(row)}`,
  ]
}

/** The full message as a read-only $EDITOR document (.jsonc — comments carry metadata). */
export function editorDocument(row: DecodedMessage, now: Date): string {
  const head = ["// topiq message (read-only view)", ...metadataHeader(row, now)]
  const headers = Object.fromEntries(
    Object.entries(row.headers).map(([name, bytes]) => [name, headerDisplay(bytes)]),
  )
  const body = row.decodeError
    ? stringifyPretty({
        decodeError: row.decodeError,
        keyRaw: row.key === null ? null : hexDump(row.key),
        valueRaw: row.value === null ? null : hexDump(row.value),
        headers,
      })
    : stringifyPretty({ key: row.decodedKey, value: row.decodedValue, headers })
  return `${head.join("\n")}\n${body}\n`
}

function schemaSummary(row: DecodedMessage): string {
  const parts: string[] = []
  if (row.valueSchemaId !== undefined) {
    parts.push(`value id ${row.valueSchemaId}`)
  }
  if (row.keySchemaId !== undefined) {
    parts.push(`key id ${row.keySchemaId}`)
  }
  return parts.length > 0 ? parts.join(" · ") : "none"
}

function sizeSummary(row: DecodedMessage): string {
  const value = row.value === null ? "value ∅" : `value ${row.value.byteLength} B`
  const key = row.key === null ? "key null" : `key ${row.key.byteLength} B`
  return `${value} · ${key}`
}
