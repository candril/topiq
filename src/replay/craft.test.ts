import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClusterProfile } from "@/config/schema.ts"
import type { Suspendable } from "@/editor/view.ts"
import { decodeMessage } from "@/schema/decode.ts"
import type { LatestSchema, SchemaRegistry } from "@/schema/registry.ts"
import type { RawMessage } from "@/types.ts"
import { craftMessage } from "./craft.ts"

// The whole spec 015 round trip, including the real $EDITOR spawn: a stub editor script
// stands in for vim and rewrites the temp file, which is the only way to prove the buffer
// this flow writes is the buffer it can read back.
//
// Never a Kafka client: nothing in this file can reach a broker even by accident. The flow
// stops at the confirm dialog, which is where the produce would start.

const VALUE_SCHEMA = JSON.stringify({
  type: "record",
  name: "Order",
  fields: [
    { name: "CustomerId", type: "long" },
    { name: "Note", type: ["null", "string"] },
    { name: "Blob", type: "bytes" },
  ],
})
const KEY_SCHEMA = JSON.stringify({ type: "long" })

const VALUE_ID = 77
const KEY_ID = 9

const SCHEMAS: Record<number, string> = { [VALUE_ID]: VALUE_SCHEMA, [KEY_ID]: KEY_SCHEMA }

const LATEST: Record<string, LatestSchema> = {
  "dg-orders-value": {
    subject: "dg-orders-value",
    id: VALUE_ID,
    version: 7,
    schema: VALUE_SCHEMA,
  },
  "dg-orders-key": { subject: "dg-orders-key", id: KEY_ID, version: 2, schema: KEY_SCHEMA },
}

function registryFor(subjects: Record<string, LatestSchema>): SchemaRegistry {
  return {
    async getSchemaById(id: number) {
      const schema = SCHEMAS[id]
      if (schema === undefined) {
        throw new Error(`unknown schema id ${id}`)
      }
      return schema
    },
    async getLatestSchema(subject: string) {
      return subjects[subject] ?? null
    },
    async getVersionForId(subject: string, id: number) {
      const latest = subjects[subject]
      return latest?.id === id ? latest.version : null
    },
  }
}

const registry = registryFor(LATEST)
const valueOnlyRegistry = registryFor({ "dg-orders-value": LATEST["dg-orders-value"]! })

function profile(over: Partial<ClusterProfile> = {}): ClusterProfile {
  return {
    name: "orders-test",
    brokers: ["broker:9092"],
    registry: "https://registry:443",
    sasl: { mechanism: "scram-sha-256", username: "u" },
    passwordCmd: "echo hunter2",
    env: "test",
    allowWrite: true,
    ...over,
  }
}

const BIG = 9007199254740993n
const NOW = new Date("2026-08-28T12:14:00Z")

const scriptDir = mkdtempSync(join(tmpdir(), "topiq-craft-test-"))
const editorScript = join(scriptDir, "fake-editor.sh")
const replacementPath = join(scriptDir, "replacement.json")
const capturedPath = join(scriptDir, "opened.txt")

function writeEditorScript(body: string): void {
  writeFileSync(editorScript, body, { mode: 0o755 })
  chmodSync(editorScript, 0o755)
}

const originalEditor = process.env.EDITOR

beforeEach(() => {
  process.env.EDITOR = editorScript
  // Default: the editor opened and quit, leaving the skeleton exactly as it was.
  writeEditorScript(`#!/bin/sh\ncat "$1" > "${capturedPath}"\n`)
})

afterAll(() => {
  process.env.EDITOR = originalEditor
})

/** What the editor will leave in the buffer. The opened buffer is captured first, so a test
 *  can assert on the skeleton the user was shown. */
function saves(body: string): void {
  writeFileSync(replacementPath, body)
  writeEditorScript(`#!/bin/sh\ncat "$1" > "${capturedPath}"\ncat "${replacementPath}" > "$1"\n`)
}

function fakeRenderer(): Suspendable & { suspends: number; resumes: number } {
  return {
    suspends: 0,
    resumes: 0,
    suspend() {
      this.suspends += 1
    },
    resume() {
      this.resumes += 1
    },
  }
}

async function run(
  over: { profile?: ClusterProfile | null; registry?: SchemaRegistry; topic?: string } = {},
) {
  const renderer = fakeRenderer()
  const outcome = await craftMessage({
    renderer,
    registry: over.registry ?? registry,
    profile: over.profile === undefined ? profile() : over.profile,
    topic: over.topic ?? "dg-orders",
    now: () => NOW,
  })
  return { outcome, renderer }
}

/** Decode produced bytes back through the ordinary read path — the only proof that what
 *  was encoded is what a consumer will see. */
async function decoded(value: Buffer, key: Buffer | null) {
  const raw: RawMessage = {
    topic: "dg-orders",
    partition: 0,
    offset: 0n,
    timestamp: NOW,
    key,
    value,
    headers: {},
  }
  return await decodeMessage(raw, registry)
}

describe("craftMessage — the round trip", () => {
  test("the skeleton opened in the editor is valid and typed by schema", async () => {
    const { outcome } = await run()
    expect(outcome.kind).toBe("confirm")
    const opened = await Bun.file(capturedPath).text()
    // A long placeholder written as bare digits, bytes as full hex — both read back by type.
    expect(opened).toContain('"CustomerId": 0')
    expect(opened).toContain('"Blob": "0x"')
    expect(opened).toContain("dg-orders-value v7 (id 77)")
  })

  test("an untouched skeleton is produced, not aborted — a default event is a real intent", async () => {
    const { outcome } = await run()
    if (outcome.kind !== "confirm") {
      throw new Error(`expected confirm, got ${outcome.kind}`)
    }
    const record = outcome.produce.records[0]!
    const back = await decoded(record.value!, record.key)
    // Note is `["null","string"]` and comes out as the non-null branch: the buffer header
    // lists the branches, so setting it back to null is a decision, not a discovery.
    expect({ ...(back.decodedValue as object) }).toEqual({
      CustomerId: 0n,
      Note: "",
      Blob: Buffer.alloc(0),
    })
  })

  test("a long above 2^53 arrives in the produced bytes exactly", async () => {
    saves(`{"key": 5, "value": {"CustomerId": ${BIG}, "Note": "hi", "Blob": "0xabab"}}`)
    const { outcome } = await run()
    if (outcome.kind !== "confirm") {
      throw new Error(`expected confirm, got ${outcome.kind}`)
    }
    const record = outcome.produce.records[0]!
    const back = await decoded(record.value!, record.key)
    const value = back.decodedValue as { CustomerId: bigint; Blob: Buffer }
    expect(value.CustomerId).toBe(BIG)
    expect(value.CustomerId === 9007199254740992n).toBe(false)
    expect(value.Blob.equals(Buffer.from([0xab, 0xab]))).toBe(true)
    // The key went through its own subject's schema, so it decodes as a BigInt long.
    expect(back.decodedKey).toBe(5n)
  })

  test("the value is framed with the subject's latest id", async () => {
    const { outcome } = await run()
    if (outcome.kind !== "confirm") {
      throw new Error(`expected confirm, got ${outcome.kind}`)
    }
    const produced = outcome.produce.records[0]!.value!
    expect(produced.readUInt8(0)).toBe(0)
    expect(produced.readUInt32BE(1)).toBe(VALUE_ID)
  })

  test("headers are produced as UTF-8 bytes", async () => {
    saves(
      `{"key": 1, "value": {"CustomerId": 1, "Note": null, "Blob": "0x"}, "headers": {"traceparent": "00-abc-01"}}`,
    )
    const { outcome } = await run()
    if (outcome.kind !== "confirm") {
      throw new Error(`expected confirm, got ${outcome.kind}`)
    }
    expect(outcome.produce.records[0]!.headers.traceparent?.toString("utf8")).toBe("00-abc-01")
  })

  test("a null key produces a record with no key, and no partition is pinned", async () => {
    saves(`{"key": null, "value": {"CustomerId": 1, "Note": null, "Blob": "0x"}}`)
    const { outcome } = await run()
    if (outcome.kind !== "confirm") {
      throw new Error(`expected confirm, got ${outcome.kind}`)
    }
    expect(outcome.produce.records[0]!.key).toBeNull()
    expect(outcome.produce.records[0]!.partition).toBeUndefined()
  })

  test("the gate is asked for a craft, and the dialog names the schema version", async () => {
    const { outcome } = await run()
    if (outcome.kind !== "confirm") {
      throw new Error(`expected confirm, got ${outcome.kind}`)
    }
    expect(outcome.action.kind).toBe("craft")
    expect(outcome.prompt.confirmKey).toBe("P")
    expect(outcome.prompt.lines.find((l) => l.label === "schema")?.value).toBe(
      "dg-orders-value v7 (id 77)",
    )
    expect(outcome.prompt.warnings.join(" ")).toContain("no undo")
  })

  test("the TUI is resumed even though the flow ends in a dialog", async () => {
    const { renderer } = await run()
    expect(renderer.suspends).toBe(1)
    expect(renderer.resumes).toBe(1)
  })
})

describe("craftMessage — a topic with no key schema", () => {
  test("the key skeleton is null and a string key is produced as UTF-8", async () => {
    saves(`{"key": "cust-1", "value": {"CustomerId": 1, "Note": null, "Blob": "0x"}}`)
    const { outcome } = await run({ registry: valueOnlyRegistry })
    if (outcome.kind !== "confirm") {
      throw new Error(`expected confirm, got ${outcome.kind}`)
    }
    expect(outcome.produce.records[0]!.key?.toString("utf8")).toBe("cust-1")
  })

  test("a non-string key is refused rather than guessed at", async () => {
    saves(`{"key": 5, "value": {"CustomerId": 1, "Note": null, "Blob": "0x"}}`)
    const { outcome } = await run({ registry: valueOnlyRegistry })
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") {
      return
    }
    expect(outcome.violations.map((v) => v.path)).toContain("key")
  })
})

describe("craftMessage — nothing to produce", () => {
  test("an emptied buffer produces nothing", async () => {
    saves("// topiq — craft a new message\n//\n")
    const { outcome } = await run()
    expect(outcome.kind).toBe("aborted")
    expect(outcome.kind === "aborted" && outcome.reason).toContain("emptied")
  })

  test("invalid JSON is refused with the parser's own complaint", async () => {
    saves("{oops}")
    const { outcome } = await run()
    expect(outcome.kind).toBe("refused")
  })

  test("a mistyped envelope member is refused rather than half-produced", async () => {
    saves(`{"vlaue": {"CustomerId": 1, "Note": null, "Blob": "0x"}}`)
    const { outcome } = await run()
    expect(outcome.kind).toBe("refused")
    expect(outcome.kind === "refused" && outcome.reason).toContain('"vlaue"')
  })
})

describe("craftMessage — schema violations", () => {
  test("a wrong type names the path under the envelope member it came from", async () => {
    saves(`{"key": 1, "value": {"CustomerId": "nope", "Note": null, "Blob": "0x"}}`)
    const { outcome } = await run()
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") {
      return
    }
    expect(outcome.violations.map((v) => v.path)).toContain("value.CustomerId")
  })

  test("a mistyped field name is reported rather than silently dropped", async () => {
    saves(`{"key": 1, "value": {"CustomerId": 1, "Note": null, "Blob": "0x", "Chanel": "web"}}`)
    const { outcome } = await run()
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") {
      return
    }
    expect(outcome.violations.map((v) => v.path)).toContain("value.Chanel")
  })

  test("a key that does not fit its own subject's schema is named as the key", async () => {
    saves(`{"key": "not-a-long", "value": {"CustomerId": 1, "Note": null, "Blob": "0x"}}`)
    const { outcome } = await run()
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") {
      return
    }
    expect(outcome.violations.map((v) => v.path)).toContain("key")
  })

  test("a non-string header value is refused, not coerced", async () => {
    saves(`{"key": 1, "value": {"CustomerId": 1, "Note": null, "Blob": "0x"}, "headers": {"n": 5}}`)
    const { outcome } = await run()
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") {
      return
    }
    expect(outcome.violations.map((v) => v.path)).toContain("headers.n")
  })
})

describe("craftMessage — refusals before the editor opens", () => {
  test("writes disabled refuses without spawning an editor", async () => {
    const { outcome, renderer } = await run({ profile: profile({ allowWrite: false }) })
    expect(outcome.kind).toBe("refused")
    expect(outcome.kind === "refused" && outcome.reason).toContain("allow_write")
    expect(renderer.suspends).toBe(0)
  })

  test("no cluster refuses", async () => {
    const { outcome } = await run({ profile: null })
    expect(outcome.kind).toBe("refused")
  })

  test("an unregistered value subject is refused — crafting does not register schemas", async () => {
    const { outcome, renderer } = await run({ topic: "dg-plain" })
    expect(outcome.kind).toBe("refused")
    expect(outcome.kind === "refused" && outcome.reason).toContain("dg-plain-value")
    expect(renderer.suspends).toBe(0)
  })
})
