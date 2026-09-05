import { describe, expect, test } from "bun:test"
import type { ClusterProfile } from "@/config/schema.ts"
import { groupSeekRefusal } from "@/kafka/groups.ts"
import { resolveStarts, type FetchRange } from "@/kafka/range.ts"
import type { KafkaClient } from "@/kafka/types.ts"
import { WriteBlockedError } from "@/safety/gate.ts"
import type { ConsumerGroupMeta, PartitionMeta } from "@/types.ts"
import { commitSeek, planSeek, type PendingSeek } from "./run.ts"

// A fake, never a real client: nothing in this file may reach a broker even by accident,
// and an offset seek against a live group is the one write in topiq with no undo at all.
//
// The fake mirrors the seam's contract rather than being permissive: `setGroupOffsets`
// re-reads the group's state and refuses a non-empty one exactly as `client.ts` does, so
// the rejoin-between-confirm-and-write path is actually exercised here.

const PARTITIONS: PartitionMeta[] = [
  { id: 0, low: 10n, high: 1000n },
  { id: 1, low: 0n, high: 500n },
]

interface Fake {
  client: KafkaClient
  writes: { groupId: string; topic: string; range: FetchRange }[]
  /** Swapped between describeGroup calls to simulate a group rejoining mid-flow. */
  state: { value: string; members: number }
}

function fakeClient(committed: (bigint | null)[] = [400n, 250n]): Fake {
  const writes: Fake["writes"] = []
  const state = { value: "Empty", members: 0 }
  const offsets = [...committed]
  const meta = (groupId: string): ConsumerGroupMeta => ({
    groupId,
    state: state.value,
    memberCount: state.members,
    members: [],
    offsets: PARTITIONS.map((p, i) => ({
      partition: p.id,
      committed: offsets[i] ?? null,
      high: p.high,
      lag: offsets[i] === null || offsets[i] === undefined ? null : p.high - offsets[i]!,
    })),
  })
  const client = {
    async describeGroup(groupId: string) {
      return meta(groupId)
    },
    async resolveOffsets(_topic: string, range: FetchRange) {
      return resolveStarts(range, PARTITIONS)
    },
    async setGroupOffsets(groupId: string, topic: string, range: FetchRange) {
      const refusal = groupSeekRefusal(groupId, state.value, state.members)
      if (refusal !== null) {
        throw new Error(refusal)
      }
      writes.push({ groupId, topic, range })
      for (const s of resolveStarts(range, PARTITIONS)) {
        offsets[s.partition] = s.offset
      }
    },
  } as unknown as KafkaClient
  return { client, writes, state }
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

const NOW = () => new Date("2026-08-28T12:00:00Z")

function plan(fake: Fake, range: FetchRange, over: Partial<ClusterProfile> = {}) {
  return planSeek({
    client: fake.client,
    profile: profile(over),
    groupId: "orders-projector",
    topic: "dg-orders",
    range,
    now: NOW,
  })
}

describe("planSeek", () => {
  test("resolves before → after per partition against the broker", async () => {
    const outcome = await plan(fakeClient(), { kind: "beginning" })
    expect(outcome.kind).toBe("confirm")
    if (outcome.kind !== "confirm") {
      return
    }
    expect(outcome.pending.plan.rows).toEqual([
      { partition: 0, before: 400n, after: 10n },
      { partition: 1, before: 250n, after: 0n },
    ])
    expect(outcome.pending.prompt.title).toBe("Seek orders-projector to beginning")
    expect(outcome.pending.prompt.confirmKey).toBe("S")
  })

  test("end is the high watermark, not the last message", async () => {
    const outcome = await plan(fakeClient(), { kind: "end" })
    if (outcome.kind !== "confirm") {
      throw new Error(outcome.reason)
    }
    expect(outcome.pending.plan.rows.map((r) => r.after)).toEqual([1000n, 500n])
  })

  test("a non-empty group is refused with its state, and nothing is written", async () => {
    const fake = fakeClient()
    fake.state = Object.assign(fake.state, { value: "Stable", members: 2 })
    const outcome = await plan(fake, { kind: "beginning" })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("is Stable with 2 members")
      expect(outcome.reason).toContain("stays manual")
    }
    expect(fake.writes).toHaveLength(0)
  })

  test("a read-only cluster is refused before the group is even described", async () => {
    const fake = fakeClient()
    const outcome = await plan(fake, { kind: "beginning" }, { allowWrite: false })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("allow_write is false")
    }
  })

  test("a target the group already sits on is refused as a no-op", async () => {
    const outcome = await plan(fakeClient([10n, 0n]), { kind: "beginning" })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("no partitions selected")
    }
  })
})

async function pendingFor(fake: Fake, range: FetchRange): Promise<PendingSeek> {
  const outcome = await plan(fake, range)
  if (outcome.kind !== "confirm") {
    throw new Error(outcome.reason)
  }
  return outcome.pending
}

describe("commitSeek", () => {
  test("writes the confirmed target and reports the committed offsets read back", async () => {
    const fake = fakeClient()
    const result = await commitSeek(
      fake.client,
      () => profile(),
      await pendingFor(fake, {
        kind: "beginning",
      }),
    )
    expect(fake.writes).toEqual([
      { groupId: "orders-projector", topic: "dg-orders", range: { kind: "beginning" } },
    ])
    expect(result.ok).toBe(true)
    expect(result.message).toBe("orders-projector on dg-orders now committed p0 @ 10, p1 @ 0")
  })

  test("a group that rejoined between the dialog and the keystroke is refused by the seam", async () => {
    const fake = fakeClient()
    const pending = await pendingFor(fake, { kind: "beginning" })
    fake.state.value = "PreparingRebalance"
    fake.state.members = 1
    await expect(commitSeek(fake.client, () => profile(), pending)).rejects.toThrow(
      /PreparingRebalance/,
    )
    expect(fake.writes).toHaveLength(0)
  })

  test("writes disabled between the dialog and the keystroke stop the write", async () => {
    const fake = fakeClient()
    const pending = await pendingFor(fake, { kind: "beginning" })
    await expect(
      commitSeek(fake.client, () => profile({ allowWrite: false }), pending),
    ).rejects.toBeInstanceOf(WriteBlockedError)
    expect(fake.writes).toHaveLength(0)
  })

  test("a cluster gone between the dialog and the keystroke stops the write", async () => {
    const fake = fakeClient()
    const pending = await pendingFor(fake, { kind: "beginning" })
    await expect(commitSeek(fake.client, () => null, pending)).rejects.toBeInstanceOf(
      WriteBlockedError,
    )
    expect(fake.writes).toHaveLength(0)
  })
})
