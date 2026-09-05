// Lossless rendering of decoded values (nfr/006). JSON.stringify is never called on a
// decoded value directly: it throws on BigInt, and the usual workarounds (replacer with
// toString) either quote the digits or append an "n". Every UI surface renders through
// this module so 9007199254740993 prints exactly as its digits.

const HEX_PREVIEW_BYTES = 16

export function bytesPreview(bytes: Uint8Array): string {
  const shown = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, HEX_PREVIEW_BYTES),
  ).toString("hex")
  return bytes.byteLength > HEX_PREVIEW_BYTES
    ? `0x${shown}… (${bytes.byteLength} bytes)`
    : `0x${shown}`
}

/** Every byte, no ellipsis — the form a reader can turn back into the same buffer. */
export function hexLiteral(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")}`
}

/** True for record-shaped values. Not a plain-prototype check: avsc decodes records to
 *  instances of generated classes, which must still render as objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  )
}

/** Single-line, JSON-shaped rendering. BigInt as bare digits, buffers as hex preview,
 *  `[]`/`{}`/`null` all distinct. Absent fields simply do not appear. */
export function stringify(value: unknown): string {
  return write(value, new Set())
}

function write(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null"
  }
  switch (typeof value) {
    case "undefined":
      // Distinct from "null" on purpose: conflating null and absent is the console bug
      // this tool exists to not have (nfr/006).
      return "undefined"
    case "bigint":
      return value.toString()
    case "string":
      return JSON.stringify(value)
    case "object":
      break
    default:
      return String(value)
  }
  const obj = value as object
  if (obj instanceof Uint8Array) {
    return bytesPreview(obj)
  }
  if (obj instanceof Date) {
    return JSON.stringify(obj.toISOString())
  }
  // Decoded Kafka data never cycles, but a cycle from a buggy caller must not hang the TUI.
  if (seen.has(obj)) {
    return "…"
  }
  seen.add(obj)
  const out = Array.isArray(obj) ? writeArray(obj, seen) : writeRecord(obj, seen)
  seen.delete(obj)
  return out
}

function writeArray(items: readonly unknown[], seen: Set<object>): string {
  if (items.length === 0) {
    return "[]"
  }
  return `[${items.map((item) => write(item, seen)).join(",")}]`
}

function writeRecord(obj: object, seen: Set<object>): string {
  const entries = Object.entries(obj)
  if (entries.length === 0) {
    return "{}"
  }
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${write(item, seen)}`).join(",")}}`
}

/** Short form for containers: `[3 items]` / `{2 fields}` — except empty ones, which stay
 *  `[]` / `{}` so emptiness never reads as NULL (nfr/006). Scalars fall through to
 *  stringify. */
export function summarize(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]"
    }
    return value.length === 1 ? "[1 item]" : `[${value.length} items]`
  }
  if (isRecord(value)) {
    const count = Object.keys(value).length
    if (count === 0) {
      return "{}"
    }
    return count === 1 ? "{1 field}" : `{${count} fields}`
  }
  return stringify(value)
}

/** Indented multi-line form of `stringify`, for the code preview and $EDITOR views.
 *  Same lossless leaf rules; the output is JSON-shaped so tree-sitter highlights it
 *  (byte previews are the one non-JSON token, worth the readability). */
export function stringifyPretty(value: unknown, indent: string = "  "): string {
  return writePretty(value, new Set(), indent, "", stringify)
}

/**
 * Pretty form that is *parseable* JSON, for the editable $EDITOR buffer (spec 014).
 *
 * One leaf differs from `stringifyPretty`, because that one renders for reading and this one
 * has to survive being read back: a byte array is full hex inside a JSON string, not the
 * truncated `…` preview, which would silently shorten a `bytes` field on save. BigInt stays
 * bare digits — the reader decides by schema type which numeric literals are longs, so
 * quoting them here would only make the buffer uglier (spec 014, Open Questions).
 */
export function stringifyEditable(value: unknown, indent: string = "  "): string {
  return writePretty(value, new Set(), indent, "", editableLeaf)
}

function editableLeaf(value: unknown): string {
  return value instanceof Uint8Array ? JSON.stringify(hexLiteral(value)) : stringify(value)
}

type LeafWriter = (value: unknown) => string

function writePretty(
  value: unknown,
  seen: Set<object>,
  indent: string,
  pad: string,
  leaf: LeafWriter,
): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]"
    }
    if (seen.has(value)) {
      return '"[circular]"'
    }
    seen.add(value)
    const inner = pad + indent
    const items = value.map((v) => inner + writePretty(v, seen, indent, inner, leaf))
    seen.delete(value)
    return `[\n${items.join(",\n")}\n${pad}]`
  }
  if (isRecord(value) && !(value instanceof Uint8Array) && !(value instanceof Date)) {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      return "{}"
    }
    if (seen.has(value)) {
      return '"[circular]"'
    }
    seen.add(value)
    const inner = pad + indent
    const items = entries.map(
      ([k, v]) => `${inner}${JSON.stringify(k)}: ${writePretty(v, seen, indent, inner, leaf)}`,
    )
    seen.delete(value)
    return `{\n${items.join(",\n")}\n${pad}}`
  }
  return leaf(value)
}
