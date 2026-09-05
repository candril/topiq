import { describe, expect, test } from "bun:test"
import { decodeMessage } from "@/schema/decode.ts"
import { createDemoRegistry } from "./registry.ts"
import { CUSTOMERS, INTERNAL, ORDERS, seedCluster, STATUS, UNREGISTERED_SCHEMA_ID } from "./seed.ts"

const EPOCH = new Date("2026-09-06T10:00:00Z")

function seed(scale = 1) {
  return seedCluster({ epoch: EPOCH, scale })
}

describe("seedCluster", () => {
  test("is deterministic: two seeds are byte-identical", () => {
    const a = seed()
    const b = seed()
    for (const [i, topic] of a.topics.entries()) {
      for (const [p, partition] of topic.partitions.entries()) {
        const other = b.topics[i]!.partitions[p]!
        expect(partition.log.length).toBe(other.log.length)
        for (const [n, m] of partition.log.entries()) {
          expect(m.key?.equals(other.log[n]!.key!) ?? true).toBe(true)
          const ov = other.log[n]!.value
          expect(m.value === null ? ov === null : ov !== null && m.value.equals(ov)).toBe(true)
          expect(m.timestamp.getTime()).toBe(other.log[n]!.timestamp.getTime())
        }
      }
    }
  })

  test("every topic has its planned shape, and the internal one is empty", () => {
    const s = seed()
    const byName = new Map(s.topics.map((t) => [t.name, t]))
    expect(byName.get(ORDERS)!.partitions).toHaveLength(3)
    expect(byName.get(STATUS)!.partitions).toHaveLength(2)
    expect(byName.get(CUSTOMERS)!.partitions).toHaveLength(1)
    expect(byName.get(INTERNAL)!.partitions[0]!.log).toHaveLength(0)
    const orders = byName.get(ORDERS)!.partitions.reduce((n, p) => n + p.log.length, 0)
    expect(orders).toBe(400)
    expect(
      seed(3)
        .topics.find((t) => t.name === ORDERS)!
        .partitions.reduce((n, p) => n + p.log.length, 0),
    ).toBe(1200)
  })

  test("offsets ascend from a non-zero low, and timestamps ascend with them", () => {
    for (const topic of seed().topics) {
      for (const p of topic.partitions) {
        if (p.log.length > 0) {
          expect(p.low).toBeGreaterThan(0n)
        }
        for (const [i, m] of p.log.entries()) {
          expect(m.offset).toBe(p.low + BigInt(i))
          expect(m.partition).toBe(p.id)
          if (i > 0) {
            expect(m.timestamp.getTime()).toBeGreaterThanOrEqual(p.log[i - 1]!.timestamp.getTime())
          }
        }
      }
    }
  })

  test("keys decode to BigInt above 2^53 (nfr/006 invariant 1)", async () => {
    const s = seed()
    const registry = createDemoRegistry(s)
    const first = s.topics.find((t) => t.name === ORDERS)!.partitions[0]!.log[0]!
    const decoded = await decodeMessage(first, registry)
    expect(typeof decoded.decodedKey).toBe("bigint")
    expect(decoded.decodedKey as bigint).toBeGreaterThan(2n ** 53n)
    expect(decoded.decodeError).toBeUndefined()
    const value = decoded.decodedValue as { orderId: bigint; customer: { customerId: bigint } }
    expect(value.orderId).toBe(decoded.decodedKey as bigint)
    expect(typeof value.customer.customerId).toBe("bigint")
  })

  test("the edge cases are present: one tombstone, one unregistered schema, two subtypes", async () => {
    const s = seed()
    const registry = createDemoRegistry(s)
    const all = (name: string) =>
      s.topics.find((t) => t.name === name)!.partitions.flatMap((p) => p.log)

    const tombstones = all(STATUS).filter((m) => m.value === null)
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]!.key).not.toBeNull()

    const customers = await Promise.all(all(CUSTOMERS).map((m) => decodeMessage(m, registry)))
    const failed = customers.filter((m) => m.decodeError !== undefined)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.decodeError).toContain(String(UNREGISTERED_SCHEMA_ID))
    expect(customers.length - failed.length).toBeGreaterThan(20)

    const status = await Promise.all(
      all(STATUS)
        .filter((m) => m.value !== null)
        .map((m) => decodeMessage(m, registry)),
    )
    const ids = new Set(status.map((m) => m.valueSchemaId))
    expect(ids.size).toBe(2)
    expect(status.every((m) => m.decodeError === undefined)).toBe(true)
  })

  test("every seeded order decodes", async () => {
    const s = seed()
    const registry = createDemoRegistry(s)
    const orders = s.topics.find((t) => t.name === ORDERS)!.partitions.flatMap((p) => p.log)
    const decoded = await Promise.all(orders.map((m) => decodeMessage(m, registry)))
    expect(decoded.filter((m) => m.decodeError !== undefined)).toHaveLength(0)
  })

  test("generate yields a fresh, decodable message per call and null for a silent topic", async () => {
    const s = seed()
    const registry = createDemoRegistry(s)
    const a = s.generate(ORDERS, new Date(EPOCH.getTime() + 1000))
    const b = s.generate(ORDERS, new Date(EPOCH.getTime() + 2000))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.key!.equals(b!.key!)).toBe(false)
    const decoded = await decodeMessage({ ...a!, partition: 0, offset: 0n }, registry)
    expect(decoded.decodeError).toBeUndefined()
    expect(s.generate(INTERNAL, EPOCH)).toBeNull()
  })

  test("the demo cannot reach a network: no transport import anywhere under src/demo", async () => {
    const glob = new Bun.Glob("*.ts")
    for await (const file of glob.scan({ cwd: import.meta.dir })) {
      if (file.endsWith(".test.ts")) {
        continue
      }
      const source = await Bun.file(`${import.meta.dir}/${file}`).text()
      expect(/from "kafkajs|require\("kafkajs/.test(source), `${file} imports kafkajs`).toBe(false)
      expect(source.includes("fetch("), `${file} calls fetch`).toBe(false)
    }
  })
})
