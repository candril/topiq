import { beforeAll, describe, expect, test } from "bun:test"
import type { KafkaClient } from "@/kafka/types.ts"
import type { RawMessage } from "@/types.ts"
import { createDemoClient } from "./client.ts"
import { CUSTOMERS, ORDERS, seedCluster, STATUS } from "./seed.ts"

const EPOCH = new Date("2026-09-06T10:00:00Z")

beforeAll(() => {
  process.env["TOPIQ_DEMO_LATENCY"] = "0"
})

function client(): KafkaClient {
  return createDemoClient(seedCluster({ epoch: EPOCH }))
}

async function read(
  c: KafkaClient,
  topic: string,
  opts: Parameters<KafkaClient["consume"]>[1],
): Promise<RawMessage[]> {
  const rows: RawMessage[] = []
  const handle = await c.consume(topic, opts, (m) => rows.push(m))
  await handle.done
  return rows
}

describe("demo client — reads", () => {
  test("listTopics and fetchWatermarks agree with describeTopic", async () => {
    const c = client()
    const topics = await c.listTopics()
    expect(topics.map((t) => t.name)).toContain(ORDERS)
    const [wm] = await c.fetchWatermarks([ORDERS])
    const described = await c.describeTopic(ORDERS)
    expect(wm).toEqual(described)
    expect(described.partitions).toHaveLength(3)
    for (const p of described.partitions) {
      expect(p.high).toBeGreaterThan(p.low)
    }
  })

  test("beginning reads everything, once, in offset order per partition", async () => {
    const c = client()
    const rows = await read(c, ORDERS, { range: { kind: "beginning" }, limit: 10_000 })
    expect(rows).toHaveLength(400)
    const seen = new Map<number, bigint>()
    for (const m of rows) {
      const prev = seen.get(m.partition)
      if (prev !== undefined) {
        expect(m.offset).toBe(prev + 1n)
      }
      seen.set(m.partition, m.offset)
    }
  })

  test("latestN over-fetches per partition and offset clamps", async () => {
    const c = client()
    const latest = await read(c, ORDERS, { range: { kind: "latestN", n: 9 }, limit: 10_000 })
    expect(latest.length).toBeGreaterThanOrEqual(9)
    expect(latest.length).toBeLessThanOrEqual(9)
    const meta = await c.describeTopic(ORDERS)
    const p0 = meta.partitions[0]!
    const fromOffset = await read(c, ORDERS, {
      range: { kind: "offset", offset: p0.high - 2n },
      limit: 10_000,
      partition: 0,
    })
    expect(fromOffset.map((m) => m.offset)).toEqual([p0.high - 2n, p0.high - 1n])
  })

  test("limit stops the read", async () => {
    const rows = await read(client(), ORDERS, { range: { kind: "beginning" }, limit: 7 })
    expect(rows).toHaveLength(7)
  })

  test("timestamp ranges start at the first message at or after t, or contribute nothing", async () => {
    const c = client()
    const all = await read(c, STATUS, { range: { kind: "beginning" }, limit: 10_000 })
    const cutoff = all[Math.floor(all.length / 2)]!.timestamp
    const since = await read(c, STATUS, {
      range: { kind: "timestamp", timestamp: cutoff },
      limit: 10_000,
    })
    expect(since.every((m) => m.timestamp.getTime() >= cutoff.getTime())).toBe(true)
    expect(since.length).toBeLessThan(all.length)
    const future = await c.resolveOffsets(STATUS, {
      kind: "timestamp",
      timestamp: new Date(EPOCH.getTime() + 86_400_000),
    })
    expect(future.every((s) => s.offset === null)).toBe(true)
    expect(await read(c, STATUS, { range: { kind: "end" }, limit: 100 })).toHaveLength(0)
  })

  test("startAt overrides the range and is scoped to the partition filter", async () => {
    const c = client()
    const meta = await c.describeTopic(ORDERS)
    const rows = await read(c, ORDERS, {
      range: { kind: "beginning" },
      limit: 10_000,
      partition: 1,
      startAt: meta.partitions.map((p) => ({ partition: p.id, offset: p.high - 1n })),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.partition).toBe(1)
  })

  test("an unknown topic is an error, not an empty window", async () => {
    await expect(client().describeTopic("nope")).rejects.toThrow('topic "nope" does not exist')
  })
})

describe("demo client — writes", () => {
  test("produce lands, is byte-exact on read-back, and moves the watermark", async () => {
    const c = client()
    const before = await c.describeTopic(CUSTOMERS)
    const key = Buffer.from([0, 0, 0, 0, 1, 42])
    const value = Buffer.from("not avro, still bytes")
    const [result] = await c.produce(CUSTOMERS, [
      { key, value, headers: { origin: Buffer.from("test") } },
    ])
    expect(result!.partition).toBe(0)
    expect(result!.offset).toBe(before.partitions[0]!.high)
    const after = await c.describeTopic(CUSTOMERS)
    expect(after.partitions[0]!.high).toBe(before.partitions[0]!.high + 1n)
    const rows = await read(c, CUSTOMERS, { range: { kind: "latestN", n: 1 }, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.key!.equals(key)).toBe(true)
    expect(rows[0]!.value!.equals(value)).toBe(true)
    expect(rows[0]!.headers["origin"]!.toString()).toBe("test")
    expect(rows[0]!.timestamp.getTime()).toBeGreaterThanOrEqual(EPOCH.getTime())
  })

  test("a follow delivers a produce that happens after the window drained", async () => {
    const c = client()
    const meta = await c.describeTopic(CUSTOMERS)
    const rows: RawMessage[] = []
    const handle = await c.consume(
      CUSTOMERS,
      {
        range: { kind: "end" },
        limit: Number.POSITIVE_INFINITY,
        follow: true,
        startAt: meta.partitions.map((p) => ({ partition: p.id, offset: p.high })),
      },
      (m) => rows.push(m),
    )
    await new Promise((r) => setTimeout(r, 5))
    expect(rows).toHaveLength(0)
    await c.produce(CUSTOMERS, [{ key: null, value: Buffer.from("live"), headers: {} }])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.value!.toString()).toBe("live")
    await handle.stop()
    await c.produce(CUSTOMERS, [{ key: null, value: Buffer.from("after stop"), headers: {} }])
    expect(rows).toHaveLength(1)
    await c.disconnect()
  })

  test("setGroupOffsets refuses a non-Empty group with the shared wording", async () => {
    const c = client()
    await expect(
      c.setGroupOffsets("order-processor", ORDERS, { kind: "beginning" }),
    ).rejects.toThrow(/order-processor is Stable with 2 members/)
  })

  test("setGroupOffsets moves an Empty group and the lag follows", async () => {
    const c = client()
    const before = await c.describeGroup("analytics-sink", ORDERS)
    expect(before.state).toBe("Empty")
    expect(before.offsets.every((o) => o.lag !== null && o.lag > 0n)).toBe(true)
    await c.setGroupOffsets("analytics-sink", ORDERS, { kind: "end" })
    const after = await c.describeGroup("analytics-sink", ORDERS)
    expect(after.offsets.every((o) => o.lag === 0n)).toBe(true)
  })

  test("a never-committed partition reports null lag, not zero", async () => {
    const meta = await client().describeGroup("legacy-reader", ORDERS)
    expect(meta.offsets.map((o) => o.lag === null)).toEqual([false, false, true])
    expect(meta.members[0]!.partitions).toEqual([0, 1])
  })

  test("describeGroups answers per id, in order, as describeGroup would", async () => {
    const c = client()
    const ids = ["legacy-reader", "no-such-group", "analytics-sink"]
    const batch = await c.describeGroups(ids, ORDERS)
    expect(batch.map((m) => m?.groupId)).toEqual(ids)
    expect(batch[1]?.state).toBe("Unknown")
    expect(batch[0]).toEqual(await c.describeGroup("legacy-reader", ORDERS))
  })

  test("listGroups reports state and member counts from the seed", async () => {
    const groups = await client().listGroups()
    expect(groups.find((g) => g.groupId === "order-processor")).toEqual({
      groupId: "order-processor",
      state: "Stable",
      memberCount: 2,
    })
  })
})
