import type { LatestSchema, SchemaRegistry } from "@/schema/registry.ts"
import type { SeededCluster } from "./seed.ts"

// The demo registry (spec 027): the seeded schemas behind the same three interfaces the
// HTTP client implements, so decode, edit-and-replay, craft and cross-cluster copy all run
// their real code. One instance per demo profile, as with a real registry — ids are
// registry-local (spec 016), and sharing would hide exactly the bug that rule exists for.

export function createDemoRegistry(seed: SeededCluster): SchemaRegistry {
  const byId = new Map(seed.schemas.map((s) => [s.id, s.schema]))
  const latest = new Map<string, LatestSchema>()
  for (const s of seed.schemas) {
    const current = latest.get(s.subject)
    if (!current || current.version < s.version) {
      latest.set(s.subject, { subject: s.subject, id: s.id, version: s.version, schema: s.schema })
    }
  }
  return {
    async getSchemaById(id) {
      const schema = byId.get(id)
      if (schema === undefined) {
        // Same shape of failure as a 404 from a real registry: the message shows its id
        // and its raw bytes, and says why (nfr/004).
        throw new Error(`schema id ${id} is not registered`)
      }
      return schema
    },
    async getLatestSchema(subject) {
      return latest.get(subject) ?? null
    },
    async getVersionForId(subject, id) {
      return seed.schemas.find((s) => s.subject === subject && s.id === id)?.version ?? null
    },
  }
}
