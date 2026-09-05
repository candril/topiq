import { describe, expect, test } from "bun:test"
import type { ClusterProfile } from "@/config/schema.ts"
import { normalizeKey } from "@/keys.ts"
import {
  WriteBlockedError,
  commitWrite,
  confirmResponse,
  evaluateWrite,
  type ConfirmPrompt,
  type WriteAction,
  typedConfirmSatisfied,
  writeBlockedReason,
} from "./gate.ts"

const NOW = new Date("2026-08-28T12:00:00Z")
const FRESH = new Date("2026-08-28T11:59:00Z")
const STALE = new Date("2026-08-26T12:00:00Z")

function profile(over: Partial<ClusterProfile> = {}): ClusterProfile {
  return {
    name: "orders-test",
    brokers: ["broker:9092"],
    registry: "https://registry:443",
    sasl: { mechanism: "scram-sha-256", username: "u" },
    passwordCmd: "echo hunter2",
    group: "orders",
    env: "test",
    allowWrite: true,
    ...over,
  }
}

const replay: WriteAction = { kind: "replay", topic: "dg-orders", count: 1, oldest: FRESH }

function promptFor(action: WriteAction, p: ClusterProfile = profile()): ConfirmPrompt {
  const gate = evaluateWrite(p, action, NOW)
  if (!gate.allowed) {
    throw new Error(`expected allowed, got: ${gate.reason}`)
  }
  return gate.prompt
}

function values(prompt: ConfirmPrompt): Record<string, string> {
  return Object.fromEntries(prompt.lines.map((l) => [l.label, l.value]))
}

describe("writeBlockedReason", () => {
  test("allow_write false blocks with a reason naming the cluster", () => {
    const reason = writeBlockedReason(profile({ allowWrite: false }))
    expect(reason).toContain("orders-test")
    expect(reason).toContain("allow_write")
  })

  test("no cluster blocks", () => {
    expect(writeBlockedReason(null)).toBe("no cluster is connected")
  })

  test("allow_write true does not block", () => {
    expect(writeBlockedReason(profile())).toBeNull()
  })
})

describe("evaluateWrite", () => {
  test("refuses when allow_write is false, with the reason the caller can display", () => {
    const gate = evaluateWrite(profile({ allowWrite: false }), replay, NOW)
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) {
      expect(gate.reason).toContain("allow_write is false")
    }
  })

  test("refuses an empty batch", () => {
    const gate = evaluateWrite(profile(), { ...replay, count: 0 }, NOW)
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) {
      expect(gate.reason).toContain("no messages selected")
    }
  })

  test("names action, cluster, env, topic and count", () => {
    const prompt = promptFor({ ...replay, count: 3 })
    expect(prompt.title).toBe("Replay 3 messages")
    expect(values(prompt)).toMatchObject({
      cluster: "orders-test",
      env: "test",
      topic: "dg-orders",
      messages: "3 messages",
    })
  })

  test("singular count reads as one message", () => {
    expect(values(promptFor(replay))["messages"]).toBe("1 message")
  })
})

describe("environment labelling", () => {
  test("prod comes from the declared env, never a hostname", () => {
    const prod = profile({
      name: "orders-prod",
      env: "prod",
      brokers: ["kafka-test.example:9092"],
    })
    const prompt = promptFor(replay, prod)
    expect(prompt.prod).toBe(true)
    expect(prompt.warnings).toContain("orders-prod is declared prod")
  })

  test("a prod-looking hostname without a prod env is not prod", () => {
    const prompt = promptFor(replay, profile({ brokers: ["kafka-prod.example:9092"] }))
    expect(prompt.prod).toBe(false)
  })

  test("prod = true without an env string still labels and warns", () => {
    const prompt = promptFor(replay, profile({ env: undefined, group: undefined, prod: true }))
    expect(prompt.prod).toBe(true)
    expect(values(prompt)["env"]).toBe("prod")
  })

  test("an undeclared env says so rather than guessing", () => {
    const prompt = promptFor(replay, profile({ env: undefined, group: undefined }))
    expect(values(prompt)["env"]).toBe("not declared")
    expect(prompt.prod).toBe(false)
  })
})

describe("replay age", () => {
  test("surfaces the age of the oldest message", () => {
    expect(values(promptFor(replay))["age"]).toBe("1m 0s ago")
  })

  test("a stale snapshot warns about re-applying old state", () => {
    const prompt = promptFor({ ...replay, oldest: STALE })
    expect(values(prompt)["age"]).toBe("2d 0h ago")
    expect(prompt.lines.find((l) => l.label === "age")?.tone).toBe("warn")
    expect(prompt.warnings.some((w) => w.includes("state that has since moved on"))).toBe(true)
  })

  test("a fresh message carries the age line without the stale warning", () => {
    const prompt = promptFor(replay)
    expect(prompt.lines.find((l) => l.label === "age")?.tone).toBe("normal")
    expect(prompt.warnings.some((w) => w.includes("since moved on"))).toBe(false)
  })

  test("replay never implies the original is restored in place", () => {
    const prompt = promptFor(replay)
    expect(prompt.warnings.some((w) => w.includes("new offset and timestamp"))).toBe(true)
    expect(prompt.warnings).toContain("Kafka has no undo: a produced message cannot be unproduced")
  })
})

describe("cross-cluster copy", () => {
  const source = profile({ name: "orders-prod", env: "prod" })
  const copy: WriteAction = {
    kind: "copy",
    topic: "test-orders",
    count: 2,
    oldest: FRESH,
    from: source,
    fromTopic: "dg-orders",
    schemas: [
      "value   dg-orders-value v7 (id 42) → test-orders-value v3 (id 88)",
      "key     no schema id in the payload — bytes carried verbatim",
    ],
  }

  test("states that bytes differ and why, naming both clusters", () => {
    const prompt = promptFor(copy)
    const bytes = prompt.warnings.find((w) => w.startsWith("this is not a byte copy"))
    expect(bytes).toContain("registry-local")
    expect(bytes).toContain("orders-prod")
    expect(bytes).toContain("orders-test")
  })

  test("the headline itself refuses to read as a copy", () => {
    // nfr/006 invariant 3: a title a user skims must not promise byte-exactness. The verb
    // still starts with C, which is where the confirm key comes from.
    const prompt = promptFor(copy)
    expect(prompt.title).toContain("re-encoded, not byte-exact")
    expect(prompt.confirmKey).toBe("C")
  })

  test("names the source cluster, its env and its topic", () => {
    expect(values(promptFor(copy))["from"]).toBe("orders-prod (prod) · dg-orders")
  })

  test("names the destination cluster next to its topic, not just 'topic'", () => {
    expect(values(promptFor(copy))["to"]).toBe("orders-test · test-orders")
  })

  test("both schema ids and versions are in the dialog", () => {
    const prompt = promptFor(copy)
    const schemas = prompt.lines.filter(
      (l) => l.value.startsWith("value") || l.value.startsWith("key"),
    )
    expect(prompt.lines.some((l) => l.label === "schemas")).toBe(true)
    expect(schemas[0]?.value).toContain("dg-orders-value v7 (id 42)")
    expect(schemas[0]?.value).toContain("test-orders-value v3 (id 88)")
  })

  test("gates on the destination profile, not the source", () => {
    const gate = evaluateWrite(profile({ allowWrite: false }), copy, NOW)
    expect(gate.allowed).toBe(false)
  })

  test("test to prod is named as the reversed direction", () => {
    const reversed: WriteAction = { ...copy, from: profile({ name: "orders-test", env: "test" }) }
    const gate = evaluateWrite(profile({ name: "orders-prod", env: "prod" }), reversed, NOW)
    expect(gate.allowed).toBe(true)
    if (gate.allowed) {
      expect(gate.prompt.warnings.some((w) => w.includes("reverse of the usual direction"))).toBe(
        true,
      )
    }
  })

  test("prod to test does not warn about a direction it is not going", () => {
    const prompt = promptFor(copy)
    expect(prompt.warnings.some((w) => w.includes("reverse of the usual"))).toBe(false)
  })
})

describe("offset seek", () => {
  const seek: WriteAction = {
    kind: "seek",
    group: "orders-projector",
    topic: "dg-orders",
    count: 6,
    to: "beginning",
    moves: ["p0 4711 → 0", "p1 — → 0"],
  }

  test("names group, topic and the partitions moved", () => {
    const prompt = promptFor(seek)
    expect(prompt.title).toBe("Seek orders-projector to beginning")
    expect(values(prompt)).toMatchObject({
      group: "orders-projector",
      topic: "dg-orders",
      to: "beginning",
      partitions: "6 partitions",
    })
  })

  test("counts partitions, not messages, when refusing an empty seek", () => {
    const gate = evaluateWrite(profile(), { ...seek, count: 0 }, NOW)
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) {
      expect(gate.reason).toContain("no partitions selected")
    }
  })

  test("does not claim message semantics it has no undo for", () => {
    const prompt = promptFor(seek)
    expect(prompt.warnings.some((w) => w.includes("not recorded anywhere"))).toBe(true)
    expect(prompt.lines.some((l) => l.label === "age")).toBe(false)
  })

  test("shows the per-partition offsets the write will commit", () => {
    const prompt = promptFor(seek)
    expect(prompt.lines.map((l) => l.value)).toEqual(
      expect.arrayContaining(["p0 4711 → 0", "p1 — → 0"]),
    )
  })

  test("says the deployment step is still the user's", () => {
    expect(promptFor(seek).warnings.some((w) => w.includes("stays manual"))).toBe(true)
  })
})

describe("re-encoding paths", () => {
  test("edit-replay says the bytes differ from the original", () => {
    const prompt = promptFor({ kind: "edit-replay", topic: "dg-orders", count: 1, oldest: FRESH })
    expect(prompt.title).toBe("Replay 1 edited message")
    expect(prompt.warnings.some((w) => w.includes("bytes differ"))).toBe(true)
  })

  test("craft has no age line — there is no original", () => {
    const prompt = promptFor({
      kind: "craft",
      topic: "dg-orders",
      count: 1,
      schema: "dg-orders-value v7 (id 1234)",
    })
    expect(prompt.title).toBe("Produce 1 crafted message")
    expect(prompt.lines.some((l) => l.label === "age")).toBe(false)
  })

  test("craft names the schema version it encoded against — latest is not taken on trust", () => {
    const prompt = promptFor({
      kind: "craft",
      topic: "dg-orders",
      count: 1,
      schema: "dg-orders-value v7 (id 1234)",
    })
    expect(prompt.lines.find((l) => l.label === "schema")?.value).toBe(
      "dg-orders-value v7 (id 1234)",
    )
  })
})

describe("confirmResponse", () => {
  const prompt = promptFor(replay)

  test("the confirm key is the title's verb, so hint and key cannot drift", () => {
    expect(prompt.confirmKey).toBe("R")
    expect(prompt.hint).toBe("shift+R to replay · esc to cancel")
  })

  test("shift+letter confirms", () => {
    expect(confirmResponse(prompt, normalizeKey({ name: "r", shift: true }))).toBe("confirm")
  })

  test("a terminal sending an uppercase name without the shift flag still confirms", () => {
    expect(confirmResponse(prompt, normalizeKey({ name: "R" }))).toBe("confirm")
  })

  test("enter is not an answer — the reflex that dismisses every other prompt does nothing", () => {
    expect(confirmResponse(prompt, normalizeKey({ name: "return" }))).toBeNull()
    expect(confirmResponse(prompt, normalizeKey({ name: "enter" }))).toBeNull()
  })

  test("a bare y is not an answer", () => {
    expect(confirmResponse(prompt, normalizeKey({ name: "y" }))).toBeNull()
  })

  test("the lowercase letter alone is not an answer", () => {
    expect(confirmResponse(prompt, normalizeKey({ name: "r" }))).toBeNull()
  })

  test("ctrl+letter is not an answer", () => {
    expect(confirmResponse(prompt, normalizeKey({ name: "r", shift: true, ctrl: true }))).toBeNull()
  })

  test("esc cancels; an unrelated key does nothing", () => {
    expect(confirmResponse(prompt, normalizeKey({ name: "escape" }))).toBe("cancel")
    expect(confirmResponse(prompt, normalizeKey({ name: "x" }))).toBeNull()
  })

  test("each dialog's key follows its own verb", () => {
    const copyPrompt = promptFor({
      kind: "copy",
      topic: "t",
      count: 1,
      oldest: FRESH,
      from: profile(),
      fromTopic: "t",
      schemas: [],
    })
    expect(copyPrompt.confirmKey).toBe("C")
    expect(confirmResponse(copyPrompt, normalizeKey({ name: "r", shift: true }))).toBeNull()
  })
})

describe("commitWrite", () => {
  test("runs the write when the live profile still allows it", async () => {
    const result = await commitWrite(
      () => profile(),
      replay,
      () => Promise.resolve("produced"),
    )
    expect(result).toBe("produced")
  })

  test("refuses when the profile lost allow_write after the dialog opened", async () => {
    // The dialog was built against a writable profile; a config reload replaced it.
    let live = profile()
    const gate = evaluateWrite(live, replay, NOW)
    expect(gate.allowed).toBe(true)
    live = profile({ allowWrite: false })

    let produced = false
    const attempt = commitWrite(
      () => live,
      replay,
      () => {
        produced = true
        return Promise.resolve("produced")
      },
    )
    await expect(attempt).rejects.toBeInstanceOf(WriteBlockedError)
    expect(produced).toBe(false)
  })

  test("refuses when the cluster went away", async () => {
    await expect(
      commitWrite(
        () => null,
        replay,
        () => Promise.resolve("produced"),
      ),
    ).rejects.toThrow("no cluster is connected")
  })
})

describe("typed confirmation for production targets (spec 016 P1)", () => {
  const test1 = profile({ name: "orders-test", env: "test", allowWrite: true })
  const prod1 = profile({ name: "orders-prod", env: "prod", allowWrite: true })
  const action: WriteAction = {
    kind: "replay",
    topic: "orders",
    count: 1,
    oldest: new Date("2026-08-28T12:00:00Z"),
  }
  const NOW = new Date("2026-08-28T12:10:00Z")
  const promptFor = (p: ClusterProfile) => {
    const gate = evaluateWrite(p, action, NOW)
    if (!gate.allowed) {
      throw new Error(gate.reason)
    }
    return gate.prompt
  }

  test("a non-prod target needs no retyping", () => {
    const prompt = promptFor(test1)
    expect(prompt.typeToConfirm).toBeNull()
    expect(typedConfirmSatisfied(prompt, "")).toBe(true)
  })

  test("a prod target demands its own name, and the hint says so", () => {
    const prompt = promptFor(prod1)
    expect(prompt.typeToConfirm).toBe("orders-prod")
    expect(prompt.hint).toContain("type orders-prod")
    expect(typedConfirmSatisfied(prompt, "")).toBe(false)
    expect(typedConfirmSatisfied(prompt, "orders-prod")).toBe(true)
  })

  test("surrounding whitespace is forgiven; a near miss is not", () => {
    const prompt = promptFor(prod1)
    expect(typedConfirmSatisfied(prompt, "  orders-prod  ")).toBe(true)
    // Case-sensitive on purpose: a cluster name is an identifier, and accepting a
    // near-miss would defeat the point of retyping it.
    expect(typedConfirmSatisfied(prompt, "ORDERS-PROD")).toBe(false)
    expect(typedConfirmSatisfied(prompt, "orders-pro")).toBe(false)
    expect(typedConfirmSatisfied(prompt, "orders-prod ish")).toBe(false)
  })

  test("prod-ness is the declared env, never the hostname", () => {
    const looksProd = profile({
      name: "kafka-prod-example",
      env: "test",
      allowWrite: true,
    })
    expect(promptFor(looksProd).typeToConfirm).toBeNull()
  })

  test("every write kind against prod is covered, not only a copy", () => {
    const seek: WriteAction = {
      kind: "seek",
      group: "g",
      topic: "orders",
      count: 2,
      to: "beginning",
      moves: ["p0 12 → 0", "p1 8 → 0"],
    }
    const gate = evaluateWrite(prod1, seek, NOW)
    expect(gate.allowed && gate.prompt.typeToConfirm).toBe("orders-prod")
  })
})
