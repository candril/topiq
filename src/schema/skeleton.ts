import type avro from "avsc"

// Spec 015: the subject's latest schema → a value you can edit.
//
// Every placeholder is a *decoded-form* value — BigInt for a long, Buffer for bytes — not
// the JSON form the buffer shows. The skeleton therefore validates against its own type
// before it is ever rendered, and it renders through src/render/json.ts exactly as a
// decoded message does. A `0` placeholder for a long would be a Number the first save
// produces silently (nfr/006 invariant 1); that is the whole reason this walks the avsc
// type instead of the schema JSON.
//
// Nothing here throws. A type this file does not know produces `null`, which the validate
// step then names with its path — the same contract as src/schema/coerce.ts.

/** A recursive type reached through itself. Only records can recurse in Avro, and a
 *  required self-reference has no finite value, so the container substitutes: an array
 *  becomes empty, a union takes its null branch, a field becomes null and is then reported
 *  as a violation rather than silently omitted. */
const CYCLE = Symbol("cycle")

export function skeletonFor(type: avro.Type): unknown {
  const built = build(type, new Set())
  return built === CYCLE ? null : built
}

/** A union position and the branches it accepts, by path — what the craft buffer's header
 *  needs to say which fields may be null and what else they could hold (spec 015 P1).
 *  Rendering is the caller's business; this is data. */
export interface UnionNote {
  /** Dotted path, `[]` for an array's items and `*` for a map's values. */
  path: string
  branches: string[]
}

export function unionNotes(type: avro.Type): UnionNote[] {
  return notes(type, "", new Set())
}

interface RecordLike extends avro.Type {
  fields: { name: string; type: avro.Type; defaultValue?: () => unknown }[]
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
interface EnumLike extends avro.Type {
  symbols: string[]
}
interface FixedLike extends avro.Type {
  size: number
}

type Built = unknown | typeof CYCLE

function build(type: avro.Type, stack: Set<avro.Type>): Built {
  switch (type.typeName) {
    case "null":
      return null
    case "boolean":
      return false
    case "int":
    case "float":
    case "double":
      return 0
    // "abstract:long" is what avsc reports for the BigInt long every schema here is parsed
    // with (src/schema/long.ts). The native "long" only reaches this file from a type built
    // outside src/schema/avroType.ts, and it rejects a BigInt — hence two answers, not one.
    case "abstract:long":
      return 0n
    case "long":
      return 0
    case "string":
      return ""
    case "bytes":
      return Buffer.alloc(0)
    case "fixed":
      // Exactly `size` bytes: a shorter buffer is not a valid fixed, so a skeleton the user
      // did not touch would fail to encode.
      return Buffer.alloc((type as FixedLike).size)
    case "enum":
      return (type as EnumLike).symbols[0] ?? ""
    case "record":
      return buildRecord(type as RecordLike, stack)
    case "array":
      return buildArray(type as ArrayLike, stack)
    case "map":
      return buildMap(type as MapLike, stack)
    case "union:wrapped":
      return buildUnion(type as UnionLike, stack, true)
    case "union:unwrapped":
      return buildUnion(type as UnionLike, stack, false)
    default:
      return null
  }
}

function buildRecord(type: RecordLike, stack: Set<avro.Type>): Built {
  if (stack.has(type)) {
    return CYCLE
  }
  stack.add(type)
  const out: Record<string, unknown> = {}
  for (const field of type.fields) {
    // A declared default is the schema's own answer to "what does this field look like when
    // nobody sets it", so it beats anything invented here. avsc hands it back already
    // decoded, which is where a `long` default's BigInt comes from.
    const declared = field.defaultValue?.()
    if (declared !== undefined) {
      out[field.name] = declared
      continue
    }
    const built = build(field.type, stack)
    out[field.name] = built === CYCLE ? null : built
  }
  stack.delete(type)
  return out
}

function buildArray(type: ArrayLike, stack: Set<avro.Type>): Built {
  const item = build(type.itemsType, stack)
  // One sample item, so the item's shape is visible in the buffer rather than something the
  // user has to reconstruct from the registry. The header says it can be deleted.
  return item === CYCLE ? [] : [item]
}

function buildMap(type: MapLike, stack: Set<avro.Type>): Built {
  const value = build(type.valuesType, stack)
  return value === CYCLE ? {} : { key: value }
}

/** First non-null branch, so the shape a crafted message usually wants is spelled out.
 *  `null` is one keystroke away and the buffer header names every branch — the reverse
 *  (defaulting to null) hides the payload shape behind a registry lookup. */
function buildUnion(type: UnionLike, stack: Set<avro.Type>, wrapped: boolean): Built {
  for (const branch of type.types) {
    if (branch.typeName === "null") {
      continue
    }
    const built = build(branch, stack)
    if (built === CYCLE) {
      continue
    }
    return wrapped ? { [branch.branchName ?? branch.typeName]: built } : built
  }
  return type.types.some((t) => t.typeName === "null") ? null : CYCLE
}

function notes(type: avro.Type, path: string, seen: Set<avro.Type>): UnionNote[] {
  switch (type.typeName) {
    case "record": {
      if (seen.has(type)) {
        return []
      }
      seen.add(type)
      const record = type as RecordLike
      const out = record.fields.flatMap((f) => notes(f.type, join(path, f.name), seen))
      seen.delete(type)
      return out
    }
    case "array":
      return notes((type as ArrayLike).itemsType, `${path}[]`, seen)
    case "map":
      return notes((type as MapLike).valuesType, join(path, "*"), seen)
    case "union:wrapped":
    case "union:unwrapped": {
      const union = type as UnionLike
      const here: UnionNote = {
        path: path === "" ? "<root>" : path,
        branches: union.types.map((t) => t.branchName ?? t.typeName),
      }
      // Recurse into the branches too: an optional record's own optional fields are exactly
      // what a crafter needs to know they may drop.
      return [here, ...union.types.flatMap((t) => notes(t, path, seen))]
    }
    default:
      return []
  }
}

function join(path: string, segment: string): string {
  return path === "" ? segment : `${path}.${segment}`
}
