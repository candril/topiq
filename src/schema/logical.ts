// Avro logical date types, read back off the raw schema (spec 031).
//
// `normalizeSchema` strips `logicalType` so every long decodes through the BigInt registry
// (nfr/006 invariant 1), which is right for fidelity and leaves a timestamp field rendering
// as `1789980152905`. The annotation is still in the schema JSON, so the reading is
// recovered here: walk the schema beside the decoded value and lift the declared instants
// to `Date`.
//
// Doing this in avsc instead would not work. A registered logical type wraps the underlying
// type avsc built for `{"type":"long","logicalType":…}` — the object form that bypasses the
// `registry` option — so the value would have been through `Number` before the wrapper ever
// saw it. That is the exact trap `normalizeSchema` exists to avoid.

/**
 * The logical types that map onto a `Date` without inventing or losing anything.
 *
 * Deliberately short (spec 031). `timestamp-micros` would drop its sub-millisecond digits;
 * `time-millis` is a time of day with no date to put it on; `local-timestamp-millis` has no
 * zone, so calling it UTC states something the producer did not. Those keep their digits,
 * which is honest rather than nice.
 */
const MILLIS = "timestamp-millis"
const DAYS = "date"

const MS_PER_DAY = 86_400_000

type Json = Record<string, unknown>

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** How a schema node reads a value: as one of the date kinds, or structurally. */
type Shape =
  | { kind: "instant"; scale: "millis" | "days" }
  | { kind: "record"; fields: Map<string, unknown> }
  | { kind: "array"; items: unknown }
  | { kind: "map"; values: unknown }
  | { kind: "union"; branches: unknown[] }
  | { kind: "opaque" }

/**
 * Convert every declared date in `value` to a `Date`, leaving everything else identical.
 *
 * `schema` is the raw parsed schema JSON, not the avsc type — only the JSON still carries
 * the logical annotations. Returns the value unchanged (by identity, where nothing matched)
 * when the schema declares no dates, so the common case costs one walk and no copying.
 */
export function applyLogicalDates(schema: unknown, value: unknown): unknown {
  return convert(schema, value, new Map(), 0)
}

// A named type may be referenced before or after its definition and may reference itself.
// Depth is bounded rather than tracking a seen-set of nodes: a value is finite, so a
// recursive *schema* only recurses as far as the data actually nests, and the cap is there
// for a schema that is cyclic in a way the data is not.
const MAX_DEPTH = 64

function convert(
  schema: unknown,
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH || value === null || value === undefined) {
    return value
  }
  const shape = shapeOf(schema, defs)
  switch (shape.kind) {
    case "instant":
      return toDate(value, shape.scale)
    case "record":
      return convertRecord(shape.fields, value, defs, depth)
    case "array":
      return Array.isArray(value)
        ? value.map((item) => convert(shape.items, item, defs, depth + 1))
        : value
    case "map":
      return convertMap(shape.values, value, defs, depth)
    case "union":
      return convertUnion(shape.branches, value, defs, depth)
    case "opaque":
      return value
  }
}

function convertRecord(
  fields: Map<string, unknown>,
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
): unknown {
  if (!isJson(value)) {
    return value
  }
  let changed = false
  const out: Json = {}
  // Object.entries, not the schema's field list: avsc decodes a record to a generated class
  // instance, and rebuilding it from the schema's fields would drop anything the instance
  // carries that the field list does not name.
  for (const [key, child] of Object.entries(value)) {
    const next = fields.has(key) ? convert(fields.get(key), child, defs, depth + 1) : child
    out[key] = next
    changed ||= next !== child
  }
  return changed ? out : value
}

function convertMap(
  values: unknown,
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
): unknown {
  if (!isJson(value)) {
    return value
  }
  let changed = false
  const out: Json = {}
  for (const [key, child] of Object.entries(value)) {
    const next = convert(values, child, defs, depth + 1)
    out[key] = next
    changed ||= next !== child
  }
  return changed ? out : value
}

/**
 * A union's branches are tried in order, and only one can be a date.
 *
 * The decoded value gives no branch tag — avsc's unwrapped unions decode to the bare value —
 * so the date branch applies when the value looks like the thing a date decodes from: a
 * bigint for millis, a number for days. Every other branch is walked structurally.
 */
function convertUnion(
  branches: readonly unknown[],
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
): unknown {
  for (const branch of branches) {
    const shape = shapeOf(branch, defs)
    if (shape.kind === "instant") {
      const converted = toDate(value, shape.scale)
      if (converted !== value) {
        return converted
      }
      continue
    }
    if (shape.kind !== "opaque") {
      const converted = convert(branch, value, defs, depth + 1)
      if (converted !== value) {
        return converted
      }
    }
  }
  return value
}

/** Millis arrive as the BigInt every long decodes to; `date` is an int, so a Number. */
function toDate(value: unknown, scale: "millis" | "days"): unknown {
  if (scale === "millis") {
    // Number is exact for any instant a broker can hold: 2^53 ms is past the year 285000.
    return typeof value === "bigint" ? new Date(Number(value)) : value
  }
  return typeof value === "number" && Number.isInteger(value) ? new Date(value * MS_PER_DAY) : value
}

function shapeOf(schema: unknown, defs: Map<string, unknown>): Shape {
  if (Array.isArray(schema)) {
    return { kind: "union", branches: schema }
  }
  if (typeof schema === "string") {
    const named = defs.get(schema)
    // A primitive name, or a reference to a record defined elsewhere in the schema.
    return named === undefined ? { kind: "opaque" } : shapeOf(named, defs)
  }
  if (!isJson(schema)) {
    return { kind: "opaque" }
  }
  const logical = schema["logicalType"]
  if (logical === MILLIS) {
    return { kind: "instant", scale: "millis" }
  }
  if (logical === DAYS) {
    return { kind: "instant", scale: "days" }
  }
  const type = schema["type"]
  if (type === "record" || type === "error") {
    const name = schema["name"]
    if (typeof name === "string") {
      defs.set(name, schema)
    }
    return { kind: "record", fields: fieldMap(schema["fields"]) }
  }
  if (type === "array") {
    return { kind: "array", items: schema["items"] }
  }
  if (type === "map") {
    return { kind: "map", values: schema["values"] }
  }
  if (Array.isArray(type)) {
    return { kind: "union", branches: type }
  }
  // `{"type": {...}}` — the nested form, e.g. a field whose type is an inline record.
  return isJson(type) || typeof type === "string" ? shapeOf(type, defs) : { kind: "opaque" }
}

function fieldMap(fields: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (!Array.isArray(fields)) {
    return out
  }
  for (const field of fields) {
    if (isJson(field) && typeof field["name"] === "string") {
      out.set(field["name"], field["type"])
    }
  }
  return out
}
