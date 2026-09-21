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
 * Dropping the logical annotation costs avsc nothing: no logical types are registered, so
 * it already ignores them and keeps the underlying type. The reading is not lost either —
 * `logical.ts` recovers declared dates from the raw schema after decode (spec 031), which
 * is the only order that works: a logical type registered here would wrap the Number-based
 * long avsc builds for the object form, i.e. the very trap this walk exists to avoid.
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

/** The avsc type and the schema it was built from. The raw JSON is kept because
 *  `normalizeSchema` drops the logical annotations on the way into avsc, and reading a
 *  declared date back off the schema needs them (spec 031). */
interface CachedSchema {
  type: avro.Type
  /** Parsed schema JSON, exactly as the registry serves it — annotations intact. */
  json: unknown
}

// Keyed by registry instance: schema ids are registry-local, so a shared cache would
// hand one cluster's type to another cluster's bytes (spec 016).
const typeCache = new WeakMap<SchemaFetcher, Map<number, CachedSchema>>()

async function cachedForId(registry: SchemaFetcher, id: number): Promise<CachedSchema> {
  let schemas = typeCache.get(registry)
  if (!schemas) {
    schemas = new Map()
    typeCache.set(registry, schemas)
  }
  const cached = schemas.get(id)
  if (cached) {
    return cached
  }
  const raw = await registry.getSchemaById(id)
  const entry: CachedSchema = { type: parseType(raw), json: JSON.parse(raw) }
  schemas.set(id, entry)
  return entry
}

export async function typeForSchemaId(registry: SchemaFetcher, id: number): Promise<avro.Type> {
  return (await cachedForId(registry, id)).type
}

/** The schema as the registry serves it, for the logical types avsc was not given. */
export async function schemaJsonForId(registry: SchemaFetcher, id: number): Promise<unknown> {
  return (await cachedForId(registry, id)).json
}
