import type avro from "avsc"
import type { SchemaViolation } from "./encode.ts"

// Reconciling a hand-edited JSON buffer with its schema (spec 014): JSON has no BigInt and
// no bytes, so the buffer's `4` and `"0xff00"` are turned back into `4n` and a Buffer *by
// schema position*, and anything the schema has no position for is named rather than
// dropped.
//
// Spec 014's open question is resolved here: longs are written as bare numeric literals and
// read back by field type. The alternative — quoting them, or tagging them with a suffix —
// makes the buffer non-JSON to every editor and asks the user to keep a convention the
// schema already knows. The type walk means an `int` field never becomes a BigInt and a
// `long` field never stays a Number, whatever the literal looked like (nfr/006 invariant 1).
//
// Nothing here throws: a value that cannot be coerced is passed through unchanged, so
// validate() reports it with its path rather than this module failing without one.

const HEX = /^0x([0-9a-fA-F]*)$/

const ROOT = "<root>"

/**
 * Walk `value` against `type`, converting the JSON forms back to the ones avsc encodes from.
 * Safe to call on an already-decoded value: every conversion is a no-op on its own output.
 */
export function coerceToType(type: avro.Type, value: unknown): unknown {
  switch (type.typeName) {
    // "abstract:long" is what avsc reports for a LongType.__with override, which is exactly
    // the BigInt long every schema here is parsed with (src/schema/long.ts). Matching only
    // "long" would skip every long in the estate — the one case this module exists for.
    case "long":
    case "abstract:long":
      return coerceLong(value)
    case "bytes":
    case "fixed":
      return coerceBytes(value)
    case "record":
      return coerceRecord(type as RecordLike, value)
    case "array":
      return coerceArray(type as ArrayLike, value)
    case "map":
      return coerceMap(type as MapLike, value)
    case "union:wrapped":
      return coerceWrappedUnion(type as UnionLike, value)
    case "union:unwrapped":
      return coerceUnwrappedUnion(type as UnionLike, value)
    default:
      return value
  }
}

/**
 * Object keys the schema has no field for. avsc encodes records field by field and ignores
 * the rest, so without this a mistyped field name is written as a message *missing* that
 * field — the edit looks applied and is not (nfr/006).
 */
export function unknownFields(
  type: avro.Type,
  value: unknown,
  path: string = ROOT,
): SchemaViolation[] {
  switch (type.typeName) {
    case "record":
      return recordUnknowns(type as RecordLike, value, path)
    case "array":
      return Array.isArray(value)
        ? value.flatMap((item, i) =>
            unknownFields((type as ArrayLike).itemsType, item, join(path, String(i))),
          )
        : []
    case "map":
      return isPlainObject(value)
        ? Object.entries(value).flatMap(([key, item]) =>
            unknownFields((type as MapLike).valuesType, item, join(path, key)),
          )
        : []
    case "union:wrapped": {
      const named = wrappedBranch(type as UnionLike, value)
      return named === null ? [] : unknownFields(named.branch, named.inner, join(path, named.name))
    }
    case "union:unwrapped": {
      const branch = unwrappedBranch(type as UnionLike, value)
      return branch === null ? [] : unknownFields(branch, value, path)
    }
    default:
      return []
  }
}

interface RecordLike extends avro.Type {
  fields: { name: string; type: avro.Type }[]
}
interface ArrayLike extends avro.Type {
  itemsType: avro.Type
}
interface MapLike extends avro.Type {
  valuesType: avro.Type
}
interface UnionLike extends avro.Type {
  types: avro.Type[]
}

function join(path: string, segment: string): string {
  return path === ROOT ? segment : `${path}.${segment}`
}

function coerceLong(value: unknown): unknown {
  return typeof value === "number" && Number.isInteger(value) ? BigInt(value) : value
}

function coerceBytes(value: unknown): unknown {
  if (typeof value !== "string") {
    return value
  }
  const hex = HEX.exec(value)
  // An odd digit count is half a byte: passing the string through makes it a violation with
  // a path, which beats Buffer.from silently dropping the stray nibble.
  if (hex === null || hex[1]!.length % 2 !== 0) {
    return value
  }
  return Buffer.from(hex[1]!, "hex")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function coerceRecord(type: RecordLike, value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value
  }
  const out: Record<string, unknown> = { ...value }
  for (const field of type.fields) {
    if (field.name in out) {
      out[field.name] = coerceToType(field.type, out[field.name])
    }
  }
  return out
}

function recordUnknowns(type: RecordLike, value: unknown, path: string): SchemaViolation[] {
  if (!isPlainObject(value)) {
    return []
  }
  const known = new Map(type.fields.map((f) => [f.name, f.type]))
  return Object.entries(value).flatMap(([key, item]) => {
    const field = known.get(key)
    if (field === undefined) {
      const where = type.name ?? "the record"
      return [
        {
          path: join(path, key),
          value: item,
          expected: "no such field",
          message: `no such field in ${where} — it would be dropped, not written`,
        },
      ]
    }
    return unknownFields(field, item, join(path, key))
  })
}

function coerceArray(type: ArrayLike, value: unknown): unknown {
  return Array.isArray(value) ? value.map((item) => coerceToType(type.itemsType, item)) : value
}

function coerceMap(type: MapLike, value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, coerceToType(type.valuesType, item)]),
  )
}

function wrappedBranch(
  type: UnionLike,
  value: unknown,
): { name: string; branch: avro.Type; inner: unknown } | null {
  if (!isPlainObject(value)) {
    return null
  }
  const entries = Object.entries(value)
  if (entries.length !== 1) {
    return null
  }
  const [name, inner] = entries[0] as [string, unknown]
  const branch = type.types.find((t) => t.branchName === name)
  return branch === undefined ? null : { name, branch, inner }
}

/** avsc wraps a multi-branch union as `{ "<branchName>": value }`, and that is what the
 *  buffer shows, so the branch is read from the key rather than guessed. */
function coerceWrappedUnion(type: UnionLike, value: unknown): unknown {
  const named = wrappedBranch(type, value)
  return named === null ? value : { [named.name]: coerceToType(named.branch, named.inner) }
}

/** An unwrapped union is written bare, so the branch has to be found: coerce against each in
 *  schema order and keep the first that then validates. Schema order is avsc's own tie-break
 *  when it encodes, so this picks the branch the writer would have picked. */
function coerceUnwrappedUnion(type: UnionLike, value: unknown): unknown {
  if (value === null) {
    return null
  }
  for (const branch of type.types) {
    const coerced = coerceToType(branch, value)
    if (branch.isValid(coerced)) {
      return coerced
    }
  }
  return value
}

/** Which branch an unwrapped union's value belongs to, for reporting. The fallback matters:
 *  `["null", SomeRecord]` with a mistyped field inside is valid against no branch at all, and
 *  giving up there would swallow the very report this walk is for. */
function unwrappedBranch(type: UnionLike, value: unknown): avro.Type | null {
  const matched = type.types.find((t) => t.isValid(value))
  if (matched !== undefined) {
    return matched
  }
  const nonNull = type.types.filter((t) => t.typeName !== "null")
  return nonNull.length === 1 ? nonNull[0]! : null
}
