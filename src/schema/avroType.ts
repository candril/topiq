import avro from "avsc"
import { longType } from "./long.ts"
import type { SchemaFetcher } from "./registry.ts"

// One place builds avsc types, so decode and encode can never disagree about what a
// schema means — an asymmetric long type would round-trip a message into a different
// one (nfr/006 invariants 1 and 2).

const PRIMITIVES = new Set(["null", "boolean", "int", "long", "float", "double", "bytes", "string"])

export function parseType(raw: string): avro.Type {
  return avro.Type.forSchema(normalizeSchema(JSON.parse(raw)) as avro.Schema, {
    registry: { long: longType },
  })
}

/**
 * Rewrite object-form primitives to their name form, everywhere in the schema.
 *
 * avsc trap (spec 005, spike finding): `{"type":"long"}` bypasses the `registry` option and
 * builds avsc's own LongType, which decodes to Number. The walk is recursive because the
 * form that actually occurs in the estate is a *nested* one —
 * `{"type":"long","logicalType":"timestamp-millis"}` — and that field would then be the one
 * long in the message that is not a BigInt (nfr/006 invariant 1), inconsistent with every
 * other long for anything that walks types by name (src/schema/coerce.ts, skeleton.ts).
 *
 * Dropping the logical annotation costs nothing: no logical types are registered, so avsc
 * already ignores it and keeps the underlying type.
 */
function normalizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeSchema)
  }
  if (typeof node !== "object" || node === null) {
    return node
  }
  const schema = node as Record<string, unknown>
  const type = schema.type
  if (typeof type === "string" && PRIMITIVES.has(type)) {
    return type
  }
  if (Array.isArray(type)) {
    return { ...schema, type: type.map(normalizeSchema) }
  }
  switch (type) {
    case "record":
    case "error":
      return { ...schema, fields: normalizeFields(schema.fields) }
    case "array":
      return { ...schema, items: normalizeSchema(schema.items) }
    case "map":
      return { ...schema, values: normalizeSchema(schema.values) }
    default:
      return typeof type === "object" ? { ...schema, type: normalizeSchema(type) } : schema
  }
}

function normalizeFields(fields: unknown): unknown {
  if (!Array.isArray(fields)) {
    return fields
  }
  return fields.map((field: unknown) => {
    if (typeof field !== "object" || field === null) {
      return field
    }
    const f = field as Record<string, unknown>
    return { ...f, type: normalizeSchema(f.type) }
  })
}

// Keyed by registry instance: schema ids are registry-local, so a shared cache would
// hand one cluster's type to another cluster's bytes (spec 016).
const typeCache = new WeakMap<SchemaFetcher, Map<number, avro.Type>>()

export async function typeForSchemaId(registry: SchemaFetcher, id: number): Promise<avro.Type> {
  let types = typeCache.get(registry)
  if (!types) {
    types = new Map()
    typeCache.set(registry, types)
  }
  const cached = types.get(id)
  if (cached) {
    return cached
  }
  const type = parseType(await registry.getSchemaById(id))
  types.set(id, type)
  return type
}
