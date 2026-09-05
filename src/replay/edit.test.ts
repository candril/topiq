import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClusterProfile } from "@/config/schema.ts"
import type { Suspendable } from "@/editor/view.ts"
import { decodeMessage } from "@/schema/decode.ts"
import { encodeWithSchema } from "@/schema/encode.ts"
import type { LatestSchema, SchemaRegistry } from "@/schema/registry.ts"
import type { DecodedMessage, RawMessage } from "@/types.ts"
import { editAndReplay } from "./edit.ts"

// The whole spec 014 round trip, including the real $EDITOR spawn: a stub editor script
// stands in for vim and rewrites the temp file, which is the only way to prove the buffer
// this flow writes is the buffer it can read back.
//
// Never a Kafka client: nothing in this file can reach a broker even by accident. The flow
// stops at the confirm dialog, which is where the produce would start.

const OLD_SCHEMA = JSON.stringify({
  type: "record",
  name: "Order",
  fields: [
    { name: "CustomerId", type: "long" },
    { name: "Note", type: ["null", "string"] },
    { name: "Blob", type: "bytes" },
  ],
})
// The subject's *latest*: one field wider. Editing an old message must never reach it.
const NEW_SCHEMA = JSON.stringify({
  type: "record",
  name: "Order",
  fields: [
    { name: "CustomerId", type: "long" },
    { name: "Note", type: ["null", "string"] },
    { name: "Blob", type: "bytes" },
    { name: "Channel", type: "string" },
  ],
})

const KEY_SCHEMA = JSON.stringify({ type: "long" })

const OLD_ID = 42
const NEW_ID = 99
const KEY_ID = 9

const SCHEMAS: Record<number, string> = {
  [OLD_ID]: OLD_SCHEMA,
  [NEW_ID]: NEW_SCHEMA,
  [KEY_ID]: KEY_SCHEMA,
}

const registry: SchemaRegistry = {
  async getSchemaById(id: number) {
    const schema = SCHEMAS[id]
    if (schema === undefined) {
      throw new Error(`unknown schema id ${id}`)
    }
    return schema
  },
  async getLatestSchema(): Promise<LatestSchema | null> {
    // Reaching for the latest schema from an *edit* is the silent-upgrade bug spec 014 names
    // explicitly, so it fails the test rather than returning something plausible.
    throw new Error("edit-and-replay must not consult the subject's latest schema")
  },
  async getVersionForId(): Promise<number | null> {
    // Only a cross-cluster copy names a source version (spec 016); an edit has no use for one.
    throw new Error("edit-and-replay must not look up schema versions")
  },
}

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
const EDITED = 9007199254740995n
const BLOB = Buffer.alloc(20, 0xab)

const KEY = encodeWithSchema(KEY_SCHEMA, KEY_ID, 5n)
const HEADERS = { traceparent: Buffer.from("00-abc-01") }

function raw(over: Partial<RawMessage> = {}): RawMessage {
  return {
    topic: "dg-orders",
    partition: 2,
    offset: 981n,
    timestamp: new Date("2026-08-28T10:00:00Z"),
    key: KEY,
    value: encodeWithSchema(OLD_SCHEMA, OLD_ID, { CustomerId: BIG, Note: "hi", Blob: BLOB }),
    headers: HEADERS,
    ...over,
  }
}

async function decodedRow(over: Partial<RawMessage> = {}): Promise<DecodedMessage> {
  return await decodeMessage(raw(over), registry)
}

const NOW = new Date("2026-08-28T12:14:00Z")

// A stand-in for $EDITOR. The replacement text is baked into the script rather than passed
// through the environment on purpose: Bun.spawn snapshots the environment, so a variable set
// after startup never reaches the child and every test would silently look like "quit
// without saving".
const scriptDir = mkdtempSync(join(tmpdir(), "topiq-edit-test-"))
const editorScript = join(scriptDir, "fake-editor.sh")
const replacementPath = join(scriptDir, "replacement.json")

function writeEditorScript(body: string): void {
  writeFileSync(editorScript, body, { mode: 0o755 })
  chmodSync(editorScript, 0o755)
}

const originalEditor = process.env.EDITOR

beforeEach(() => {
  process.env.EDITOR = editorScript
  // Default: the editor opened and quit, leaving the buffer as it was.
  writeEditorScript("#!/bin/sh\nexit 0\n")
})

afterAll(() => {
  process.env.EDITOR = originalEditor
})

/** What the editor will leave in the buffer. Comments are optional: the reader strips the
 *  header block, so a body alone is a legitimate save. */
function saves(body: string): void {
  writeFileSync(replacementPath, body)
  writeEditorScript(`#!/bin/sh\ncat "${replacementPath}" > "$1"\n`)
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

async function run(row: DecodedMessage, over: { profile?: ClusterProfile | null } = {}) {
  const renderer = fakeRenderer()
  const outcome = await editAndReplay({
    renderer,
    registry,
    profile: over.profile === undefined ? profile() : over.profile,
    row,
    now: () => NOW,
  })
  return { outcome, renderer }
}

describe("editAndReplay — the round trip", () => {
  test("an edited long above 2^53 arrives in the produced bytes exactly", async () => {
    saves(`{"CustomerId": ${EDITED}, "Note": "hi", "Blob": "0x${"ab".repeat(20)}"}`)
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("confirm")
    if (outcome.kind !== "confirm") {
      return
    }
    const produced = outcome.produce.records[0]!.value!
    const back = await decodeMessage(raw({ value: produced }), registry)
    const value = back.decodedValue as { CustomerId: bigint; Blob: Buffer }
    expect(value.CustomerId).toBe(EDITED)
    expect(value.CustomerId === 9007199254740996n).toBe(false)
    // The bytes field went out as full hex and came back as the same bytes — the truncated
    // reading preview would have silently shortened it to 16.
    expect(value.Blob.equals(BLOB)).toBe(true)
  })

  test("the value is framed with the message's own schema id, not the subject's latest", async () => {
    saves(`{"CustomerId": 1, "Note": null, "Blob": "0x"}`)
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("confirm")
    if (outcome.kind !== "confirm") {
      return
    }
    const produced = outcome.produce.records[0]!.value!
    expect(produced.readUInt8(0)).toBe(0)
    expect(produced.readUInt32BE(1)).toBe(OLD_ID)
  })

  test("the key and headers are the original buffers, not re-encoded", async () => {
    saves(`{"CustomerId": 1, "Note": null, "Blob": "0x"}`)
    const row = await decodedRow()
    const { outcome } = await run(row)
    if (outcome.kind !== "confirm") {
      throw new Error(`expected confirm, got ${outcome.kind}`)
    }
    const record = outcome.produce.records[0]!
    expect(record.key).toBe(row.key)
    expect(record.headers).toBe(row.headers)
    // No partition: the key's partitioner routes it where the original went.
    expect(record.partition).toBeUndefined()
  })

  test("the gate is asked for an edit-replay, so the dialog warns about re-encoding", async () => {
    saves(`{"CustomerId": 1, "Note": null, "Blob": "0x"}`)
    const { outcome } = await run(await decodedRow())
    if (outcome.kind !== "confirm") {
      throw new Error(`expected confirm, got ${outcome.kind}`)
    }
    expect(outcome.action.kind).toBe("edit-replay")
    expect(outcome.prompt.warnings.join(" ")).toContain("bytes differ")
    expect(outcome.prompt.confirmKey).toBe("R")
  })

  test("the TUI is resumed even though the flow ends in a dialog", async () => {
    saves(`{"CustomerId": 1, "Note": null, "Blob": "0x"}`)
    const { renderer } = await run(await decodedRow())
    expect(renderer.suspends).toBe(1)
    expect(renderer.resumes).toBe(1)
  })
})

describe("editAndReplay — nothing to produce", () => {
  test("quitting the editor without saving produces nothing", async () => {
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("aborted")
    expect(outcome.kind === "aborted" && outcome.reason).toContain("unchanged")
  })

  test("changing only the comment header still counts as unchanged", async () => {
    saves(`// my own note\n{"CustomerId": ${BIG}, "Note": "hi", "Blob": "0x${"ab".repeat(20)}"}`)
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("aborted")
  })

  test("an emptied buffer produces nothing", async () => {
    saves("// topiq — edit and replay\n//\n")
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("aborted")
    expect(outcome.kind === "aborted" && outcome.reason).toContain("emptied")
  })

  test("invalid JSON is refused with the parser's own complaint", async () => {
    saves("{oops}")
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("refused")
    expect(outcome.kind === "refused" && outcome.reason).toContain("not valid JSON")
  })
})

describe("editAndReplay — schema violations", () => {
  test("a wrong type names the offending path and produces nothing", async () => {
    saves(`{"CustomerId": "nope", "Note": null, "Blob": "0x"}`)
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") {
      return
    }
    expect(outcome.violations.map((v) => v.path)).toContain("CustomerId")
  })

  test("a missing required field is a violation, not a default", async () => {
    saves(`{"Note": null, "Blob": "0x"}`)
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("invalid")
  })

  test("a mistyped field name is reported rather than silently dropped", async () => {
    saves(`{"CustomerId": 1, "Note": null, "Blob": "0x", "Chanel": "web"}`)
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") {
      return
    }
    expect(outcome.violations.map((v) => v.path)).toContain("Chanel")
  })

  test("a field only the newer schema has is rejected — no silent upgrade", async () => {
    saves(`{"CustomerId": 1, "Note": null, "Blob": "0x", "Channel": "web"}`)
    const { outcome } = await run(await decodedRow())
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") {
      return
    }
    expect(outcome.violations.map((v) => v.path)).toContain("Channel")
  })
})

describe("editAndReplay — refusals before the editor opens", () => {
  test("writes disabled refuses without spawning an editor", async () => {
    saves(`{"CustomerId": 1, "Note": null, "Blob": "0x"}`)
    const { outcome, renderer } = await run(await decodedRow(), {
      profile: profile({ allowWrite: false }),
    })
    expect(outcome.kind).toBe("refused")
    expect(outcome.kind === "refused" && outcome.reason).toContain("allow_write")
    expect(renderer.suspends).toBe(0)
  })

  test("no cluster refuses", async () => {
    const { outcome } = await run(await decodedRow(), { profile: null })
    expect(outcome.kind).toBe("refused")
  })

  test("a tombstone has no value to edit", async () => {
    const { outcome, renderer } = await run(await decodedRow({ value: null }))
    expect(outcome.kind).toBe("refused")
    expect(outcome.kind === "refused" && outcome.reason).toContain("tombstone")
    expect(renderer.suspends).toBe(0)
  })

  test("a value with no schema id cannot be validated, so it is refused", async () => {
    const plain = await decodedRow({ value: Buffer.from('{"a":1}') })
    expect(plain.valueSchemaId).toBeUndefined()
    const { outcome } = await run(plain)
    expect(outcome.kind).toBe("refused")
    expect(outcome.kind === "refused" && outcome.reason).toContain("no schema id")
  })

  test("a message that failed to decode is left to the byte-exact path", async () => {
    const broken = { ...(await decodedRow()), decodeError: "boom" }
    const { outcome } = await run(broken)
    expect(outcome.kind).toBe("refused")
    expect(outcome.kind === "refused" && outcome.reason).toContain("did not decode")
  })
})
