import { describe, expect, test } from "bun:test"
import type avro from "avsc"
import type { ClusterProfile } from "@/config/schema.ts"
import { parseType, typeForSchemaId } from "@/schema/avroType.ts"
import { decodeMessage } from "@/schema/decode.ts"
import type { LatestSchema, SchemaRegistry } from "@/schema/registry.ts"
import { body, frame, readSchemaId } from "@/schema/wire.ts"
import type { DecodedMessage, RawMessage } from "@/types.ts"
import { copyBlockedReason, planCopy, type CopySide } from "./copy.ts"

// Spec 016 + nfr/006 invariant 3. The shape of the fixture *is* the point: the same schema
// text is registered under different ids on the two registries, because that is what makes a
// cross-cluster byte copy corrupt the payload — the destination's consumers would resolve the
// source's id to whatever schema happens to hold it there.

const VALUE_SCHEMA = JSON.stringify({
  type: "record",
  name: "OrderPlaced",
  fields: [
    { name: "CustomerId", type: "long" },
    { name: "Note", type: ["null", "string"], default: null },
  ],
})

// The destination's schema for the same subject: identical text, different id — the usual
// state of two registries that were fed the same contract at different times.
const SOURCE_VALUE_ID = 42
const DEST_VALUE_ID = 88
const KEY_SCHEMA = JSON.stringify({ type: "long" })
const SOURCE_KEY_ID = 7
const DEST_KEY_ID = 13

// A destination schema that has since gained a required field. Nothing on the source topic
// carries it, so every message from there is incompatible — the case the spec calls "no
// compatible schema" that a subject-exists check alone would sail straight past.
const STRICTER_SCHEMA = JSON.stringify({
  type: "record",
  name: "OrderPlaced",
  fields: [
    { name: "CustomerId", type: "long" },
    { name: "Note", type: ["null", "string"], default: null },
    { name: "Channel", type: "string" },
  ],
})

function registry(
  schemas: Record<number, string>,
  latest: Record<string, LatestSchema>,
): SchemaRegistry {
  return {
    async getSchemaById(id: number) {
      const schema = schemas[id]
      if (schema === undefined) {
        throw new Error(`unknown schema id ${id}`)
      }
      return schema
    },
    async getLatestSchema(subject: string) {
      return latest[subject] ?? null
    },
    async getVersionForId(subject: string, id: number) {
      const found = latest[subject]
      return found?.id === id ? found.version : null
    },
  }
}

const sourceRegistry = registry(
  { [SOURCE_VALUE_ID]: VALUE_SCHEMA, [SOURCE_KEY_ID]: KEY_SCHEMA },
  {
    "dg-orders-value": {
      subject: "dg-orders-value",
      id: SOURCE_VALUE_ID,
      version: 7,
      schema: VALUE_SCHEMA,
    },
    "dg-orders-key": {
      subject: "dg-orders-key",
      id: SOURCE_KEY_ID,
      version: 1,
      schema: KEY_SCHEMA,
    },
  },
)

function destRegistry(valueSchema = VALUE_SCHEMA, withKey = true): SchemaRegistry {
  return registry(
    { [DEST_VALUE_ID]: valueSchema, [DEST_KEY_ID]: KEY_SCHEMA },
    {
      "test-orders-value": {
        subject: "test-orders-value",
        id: DEST_VALUE_ID,
        version: 3,
        schema: valueSchema,
      },
      ...(withKey
        ? {
            "test-orders-key": {
              subject: "test-orders-key",
              id: DEST_KEY_ID,
              version: 2,
              schema: KEY_SCHEMA,
            },
          }
        : {}),
    },
  )
}

function profile(over: Partial<ClusterProfile> & { name: string }): ClusterProfile {
  return {
    brokers: ["broker:9092"],
    registry: "https://registry:443",
    sasl: { mechanism: "scram-sha-256", username: "u" },
    passwordCmd: "echo hunter2",
    allowWrite: false,
    ...over,
  }
}

const prod = profile({ name: "orders-prod", group: "orders", env: "prod" })
const testProfile = profile({
  name: "orders-test",
  group: "orders",
  env: "test",
  topicPrefix: "test",
  allowWrite: true,
})

// Through parseType, not avsc directly: object-form `{"type":"long"}` bypasses the BigInt
// long registration, and the fixture would then be built from a schema the app never uses.
const valueType = parseType(VALUE_SCHEMA)
const keyType = parseType(KEY_SCHEMA)

// Past 2^53: the number this whole tool exists because a web console rounded (nfr/006).
const BIG = 9007199254740993n

function raw(over: Partial<RawMessage> = {}): RawMessage {
  return {
    topic: "dg-orders",
    partition: 3,
    offset: 4711n,
    timestamp: new Date("2026-08-28T12:00:00Z"),
    key: frame(SOURCE_KEY_ID, keyType.toBuffer(BIG)),
    value: frame(SOURCE_VALUE_ID, valueType.toBuffer({ CustomerId: BIG, Note: "hi" })),
    headers: { source: Buffer.from("orders-api") },
    ...over,
  }
}

async function decoded(over: Partial<RawMessage> = {}): Promise<DecodedMessage> {
  return await decodeMessage(raw(over), sourceRegistry)
}

function sides(destination: SchemaRegistry = destRegistry()): {
  source: CopySide
  destination: CopySide
} {
  return {
    source: { profile: prod, registry: sourceRegistry },
    destination: { profile: testProfile, registry: destination },
  }
}

const NOW = () => new Date("2026-08-28T12:05:00Z")

async function plan(over: Partial<RawMessage> = {}, dest: SchemaRegistry = destRegistry()) {
  return await planCopy({
    ...sides(dest),
    row: await decoded(over),
    destTopic: "test-orders",
    now: NOW,
  })
}

describe("re-encoding", () => {
  test("the produced value carries the destination's schema id, never the source's", async () => {
    const outcome = await plan()
    expect(outcome.kind).toBe("confirm")
    if (outcome.kind !== "confirm") {
      return
    }
    const record = outcome.produce.records[0]!
    expect(readSchemaId(record.value!)).toBe(DEST_VALUE_ID)
    expect(readSchemaId(record.key!)).toBe(DEST_KEY_ID)
  })

  test("the bytes differ from the original — that is the whole point", async () => {
    const original = raw()
    const outcome = await plan()
    if (outcome.kind !== "confirm") {
      throw new Error("expected a confirmable copy")
    }
    expect(outcome.produce.records[0]!.value!.equals(original.value!)).toBe(false)
  })

  test("the payload survives the round trip, BigInt included", async () => {
    const outcome = await plan()
    if (outcome.kind !== "confirm") {
      throw new Error("expected a confirmable copy")
    }
    const destType = await typeForSchemaId(destRegistry(), DEST_VALUE_ID)
    expect(destType.fromBuffer(body(outcome.produce.records[0]!.value!))).toEqual({
      CustomerId: BIG,
      Note: "hi",
    })
  })

  test("produces to the destination topic, and picks no partition", async () => {
    const outcome = await plan()
    if (outcome.kind !== "confirm") {
      throw new Error("expected a confirmable copy")
    }
    expect(outcome.produce.topic).toBe("test-orders")
    // The destination topic's partition count is its own; carrying p3 across would be a
    // coincidence at best.
    expect(outcome.produce.records[0]!.partition).toBeUndefined()
  })

  test("headers are carried verbatim — they reference no registry", async () => {
    const outcome = await plan()
    if (outcome.kind !== "confirm") {
      throw new Error("expected a confirmable copy")
    }
    expect(outcome.produce.records[0]!.headers["source"]?.toString()).toBe("orders-api")
  })
})

describe("the confirm dialog", () => {
  test("names both subjects, both versions and both ids", async () => {
    const outcome = await plan()
    if (outcome.kind !== "confirm") {
      throw new Error("expected a confirmable copy")
    }
    const schemas = outcome.action.kind === "copy" ? outcome.action.schemas : []
    expect(schemas[0]).toContain("dg-orders-value v7 (id 42)")
    expect(schemas[0]).toContain("test-orders-value v3 (id 88)")
    expect(schemas[1]).toContain("dg-orders-key v1 (id 7)")
    expect(schemas[1]).toContain("test-orders-key v2 (id 13)")
  })

  test("carries the message's age and both cluster profiles", async () => {
    const outcome = await plan()
    if (outcome.kind !== "confirm" || outcome.action.kind !== "copy") {
      throw new Error("expected a confirmable copy")
    }
    expect(outcome.action.from.name).toBe("orders-prod")
    expect(outcome.action.fromTopic).toBe("dg-orders")
    expect(outcome.action.oldest).toEqual(new Date("2026-08-28T12:00:00Z"))
  })

  test("a version the source registry will not name costs the version, not the copy", async () => {
    const grumpy: SchemaRegistry = {
      ...sourceRegistry,
      async getVersionForId() {
        throw new Error("registry: HTTP 500")
      },
    }
    const outcome = await planCopy({
      source: { profile: prod, registry: grumpy },
      destination: { profile: testProfile, registry: destRegistry() },
      row: await decodeMessage(raw(), sourceRegistry),
      destTopic: "test-orders",
      now: NOW,
    })
    if (outcome.kind !== "confirm" || outcome.action.kind !== "copy") {
      throw new Error("expected a confirmable copy")
    }
    expect(outcome.action.schemas[0]).toContain("dg-orders-value (id 42)")
  })
})

describe("refusals", () => {
  test("a missing destination subject aborts — never a fallback to the source bytes", async () => {
    const outcome = await plan({}, registry({}, {}))
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("no schema registered for test-orders-value")
      expect(outcome.reason).toContain("42")
    }
  })

  test("a missing destination *key* subject aborts too", async () => {
    const outcome = await plan({}, destRegistry(VALUE_SCHEMA, false))
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("test-orders-key")
    }
  })

  test("a destination schema that does not accept the message names the field", async () => {
    const outcome = await plan({}, destRegistry(STRICTER_SCHEMA))
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind === "invalid") {
      expect(outcome.violations.map((v) => v.path)).toContain("value.Channel")
    }
  })

  test("a destination schema that dropped a field refuses rather than dropping data", async () => {
    // avsc encodes field by field and ignores the rest, so without this the copy would look
    // applied and quietly arrive without Note (nfr/006).
    const narrower = JSON.stringify({
      type: "record",
      name: "OrderPlaced",
      fields: [{ name: "CustomerId", type: "long" }],
    })
    const outcome = await plan({}, destRegistry(narrower))
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind === "invalid") {
      expect(outcome.violations.map((v) => v.path)).toContain("value.Note")
    }
  })

  test("a message that did not decode cannot be copied", async () => {
    const row: DecodedMessage = {
      ...raw(),
      decodedKey: null,
      decodedValue: null,
      decodeError: "unknown schema id 99",
    }
    const outcome = await planCopy({ ...sides(), row, destTopic: "test-orders", now: NOW })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("did not decode")
    }
  })

  test("a read-only destination refuses — the gate reads the destination profile", async () => {
    const outcome = await planCopy({
      source: { profile: prod, registry: sourceRegistry },
      destination: { profile: { ...testProfile, allowWrite: false }, registry: destRegistry() },
      row: await decoded(),
      destTopic: "test-orders",
      now: NOW,
    })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("allow_write is false")
    }
  })

  test("one registry object serving both sides is refused, not trusted", async () => {
    // The bug this spec exists to prevent: one cache means the destination's ids resolve to
    // the source's schemas, silently, producing bytes that decode into another message.
    const outcome = await planCopy({
      source: { profile: prod, registry: sourceRegistry },
      destination: { profile: testProfile, registry: sourceRegistry },
      row: await decoded(),
      destTopic: "test-orders",
      now: NOW,
    })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("must not share a schema cache")
    }
  })

  test("copying onto the same cluster is refused — that is what p is for", () => {
    expect(copyBlockedReason(prod, { ...prod, allowWrite: true }, {} as DecodedMessage)).toContain(
      "same cluster",
    )
  })
})

describe("payloads with no schema id", () => {
  test("an unframed value is carried verbatim, and the dialog says so", async () => {
    const plain = Buffer.from(JSON.stringify({ hello: "world" }), "utf8")
    const outcome = await plan({ value: plain, key: Buffer.from("k-1", "utf8") })
    if (outcome.kind !== "confirm" || outcome.action.kind !== "copy") {
      throw new Error("expected a confirmable copy")
    }
    // Not a fallback from a failed lookup: bytes that reference no registry mean the same
    // thing on both clusters. The distinction is stated per field rather than inferred.
    expect(outcome.action.schemas[0]).toContain("bytes carried verbatim")
    expect(outcome.produce.records[0]!.value!.equals(plain)).toBe(true)
  })

  test("a tombstone stays a tombstone, not an empty buffer", async () => {
    const outcome = await plan({ value: null })
    if (outcome.kind !== "confirm" || outcome.action.kind !== "copy") {
      throw new Error("expected a confirmable copy")
    }
    expect(outcome.produce.records[0]!.value).toBeNull()
    expect(outcome.action.schemas[0]).toContain("tombstone")
  })
})

describe("the two schema caches", () => {
  test("the same id resolves to a different type on each registry", async () => {
    // avroType.ts keys its cache by registry instance. Asserted here rather than assumed:
    // a shared cache is invisible until it hands one cluster's schema to the other's bytes.
    const shared = 42
    const a = registry(
      { [shared]: VALUE_SCHEMA },
      {
        "dg-orders-value": {
          subject: "dg-orders-value",
          id: shared,
          version: 1,
          schema: VALUE_SCHEMA,
        },
      },
    )
    const b = registry(
      { [shared]: STRICTER_SCHEMA },
      {
        "dg-orders-value": {
          subject: "dg-orders-value",
          id: shared,
          version: 1,
          schema: STRICTER_SCHEMA,
        },
      },
    )
    const fromA = (await typeForSchemaId(a, shared)) as avro.types.RecordType
    const fromB = (await typeForSchemaId(b, shared)) as avro.types.RecordType
    expect(fromA.fields.map((f) => f.name)).toEqual(["CustomerId", "Note"])
    expect(fromB.fields.map((f) => f.name)).toEqual(["CustomerId", "Note", "Channel"])
  })
})
