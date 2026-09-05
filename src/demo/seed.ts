import { encodeWithSchema } from "@/schema/encode.ts"
import { frame } from "@/schema/wire.ts"
import type { GroupMemberMeta, RawMessage } from "@/types.ts"

// The demo cluster's data (spec 027): a fictional web shop's order flow, encoded once at
// startup with real Avro schemas behind real Confluent framing. Stored as bytes, not
// objects, so every decode/encode path in the app runs unchanged against it — byte-exact
// replay (spec 013) is then an assertion the demo can make, not a claim.
//
// Deterministic by construction: a seeded PRNG, a fixed epoch, fixed ids and offsets. The
// same keystrokes must give the same screen, or the docs pipeline (spec 028) cannot work.

export interface SeededSchema {
  id: number
  subject: string
  version: number
  schema: string
}

export interface SeededPartition {
  id: number
  /** Low watermark. Not 0: retention has run, as it has on any cluster older than a week. */
  low: bigint
  /** Offset of log[i] is low + i. */
  log: RawMessage[]
}

export interface SeededTopic {
  name: string
  partitions: SeededPartition[]
}

export interface SeededGroup {
  groupId: string
  state: string
  members: GroupMemberMeta[]
  /** topic → partition → committed offset; null = never committed (spec 017). */
  committed: Map<string, Map<number, bigint | null>>
}

export interface SeededCluster {
  epoch: Date
  schemas: SeededSchema[]
  topics: SeededTopic[]
  groups: SeededGroup[]
  /** The next message a live producer would send to `topic` at `at` — what a follow shows
   *  arriving (spec 027 P2). Null for a topic nothing produces to. */
  generate(topic: string, at: Date): Omit<RawMessage, "partition" | "offset"> | null
}

export const ORDERS = "orders.placed.v2"
export const STATUS = "orders.status-changed.v1"
export const CUSTOMERS = "customers.updated.v1"
/** Hidden behind the internal toggle (spec 006) — the toggle needs something to toggle. */
export const INTERNAL = "__consumer_offsets"

/** Framed with this id and never registered: the one row that renders `decode failed`
 *  (nfr/004). Deliberately visible, so the failure path has a screenshot. */
export const UNREGISTERED_SCHEMA_ID = 99

const KEY_ID = 1
const ORDER_PLACED_ID = 2
const STATUS_CHANGED_ID = 3
const SHIPMENT_ID = 4
const CUSTOMER_ID = 5

const KEY_SCHEMA = `"long"`

const ORDER_PLACED = JSON.stringify({
  type: "record",
  name: "OrderPlaced",
  namespace: "shop.orders",
  fields: [
    { name: "orderId", type: "long" },
    {
      name: "customer",
      type: {
        type: "record",
        name: "Customer",
        fields: [
          { name: "customerId", type: "long" },
          { name: "email", type: "string" },
          { name: "tier", type: { type: "enum", name: "Tier", symbols: ["BASIC", "PLUS", "PRO"] } },
        ],
      },
    },
    {
      name: "items",
      type: {
        type: "array",
        items: {
          type: "record",
          name: "Item",
          fields: [
            { name: "sku", type: "string" },
            { name: "name", type: "string" },
            { name: "qty", type: "int" },
            { name: "unitPrice", type: "string" },
          ],
        },
      },
    },
    { name: "total", type: "string" },
    { name: "currency", type: "string" },
    {
      name: "channel",
      type: { type: "enum", name: "Channel", symbols: ["WEB", "APP", "STORE"] },
    },
    { name: "placedAt", type: { type: "long", logicalType: "timestamp-millis" } },
  ],
})

const STATUS_CHANGED = JSON.stringify({
  type: "record",
  name: "OrderStatusChanged",
  namespace: "shop.orders",
  fields: [
    { name: "orderId", type: "long" },
    {
      name: "from",
      type: {
        type: "enum",
        name: "Status",
        symbols: ["PLACED", "PAID", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"],
      },
    },
    { name: "to", type: "shop.orders.Status" },
    { name: "reason", type: ["null", "string"], default: null },
    { name: "changedAt", type: { type: "long", logicalType: "timestamp-millis" } },
  ],
})

const SHIPMENT_DISPATCHED = JSON.stringify({
  type: "record",
  name: "ShipmentDispatched",
  namespace: "shop.orders",
  fields: [
    { name: "orderId", type: "long" },
    { name: "carrier", type: "string" },
    { name: "trackingId", type: "string" },
    { name: "parcels", type: "int" },
    { name: "etaDays", type: "int" },
    { name: "dispatchedAt", type: { type: "long", logicalType: "timestamp-millis" } },
  ],
})

const CUSTOMER_UPDATED = JSON.stringify({
  type: "record",
  name: "CustomerUpdated",
  namespace: "shop.customers",
  fields: [
    { name: "customerId", type: "long" },
    { name: "email", type: "string" },
    { name: "name", type: "string" },
    { name: "tier", type: { type: "enum", name: "Tier", symbols: ["BASIC", "PLUS", "PRO"] } },
    { name: "marketingOptIn", type: "boolean" },
    { name: "addresses", type: { type: "map", values: "string" } },
    { name: "updatedAt", type: { type: "long", logicalType: "timestamp-millis" } },
  ],
})

const SCHEMAS: SeededSchema[] = [
  { id: KEY_ID, subject: `${ORDERS}-key`, version: 1, schema: KEY_SCHEMA },
  { id: KEY_ID, subject: `${STATUS}-key`, version: 1, schema: KEY_SCHEMA },
  { id: KEY_ID, subject: `${CUSTOMERS}-key`, version: 1, schema: KEY_SCHEMA },
  { id: ORDER_PLACED_ID, subject: `${ORDERS}-value`, version: 2, schema: ORDER_PLACED },
  { id: STATUS_CHANGED_ID, subject: `${STATUS}-value`, version: 1, schema: STATUS_CHANGED },
  {
    id: SHIPMENT_ID,
    subject: `shop.orders.ShipmentDispatched`,
    version: 1,
    schema: SHIPMENT_DISPATCHED,
  },
  { id: CUSTOMER_ID, subject: `${CUSTOMERS}-value`, version: 3, schema: CUSTOMER_UPDATED },
]

const NAMES = [
  ["Mara", "Lindqvist"],
  ["Tomas", "Ferreira"],
  ["Yuki", "Anand"],
  ["Noor", "Haddad"],
  ["Leo", "Brandt"],
  ["Ines", "Okafor"],
  ["Sam", "Whitaker"],
  ["Priya", "Nair"],
  ["Elin", "Vasquez"],
  ["Kofi", "Mensah"],
]
const PRODUCTS = [
  ["SKU-4471", "Trail Runner 2", "129.00"],
  ["SKU-1180", "Merino Base Layer", "64.50"],
  ["SKU-9023", "Headlamp 600lm", "39.90"],
  ["SKU-3307", "Titanium Spork", "12.00"],
  ["SKU-7752", "Down Jacket", "249.00"],
  ["SKU-2619", "Trekking Poles", "89.00"],
  ["SKU-5540", "1L Bottle", "18.00"],
  ["SKU-8814", "Rain Shell", "159.00"],
  ["SKU-6106", "Wool Socks 3-pack", "29.00"],
  ["SKU-0392", "Map Case", "15.50"],
]
const CARRIERS = ["DHL", "UPS", "PostNL", "DPD"]
const CITIES = ["Zürich", "Lisbon", "Kyoto", "Amman", "Berlin", "Lagos", "Leeds", "Kochi"]
const TIERS = ["BASIC", "PLUS", "PRO"] as const
const CHANNELS = ["WEB", "APP", "STORE"] as const
const STATUSES = ["PLACED", "PAID", "PACKED", "SHIPPED", "DELIVERED"] as const

/** mulberry32 — small, fast, and the same sequence on every runtime. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Above 2^53 on purpose: an id that `Number` would round is the whole point of
 *  invariant 1 (nfr/006), and a demo that only shows small ids proves nothing. */
const ORDER_BASE = 9_007_199_254_740_993n
const CUSTOMER_BASE = 9_007_199_254_741_101n

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)]!
}

function money(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
}

function customerOf(i: number): { customerId: bigint; email: string; name: string } {
  const [first, last] = NAMES[i % NAMES.length]!
  return {
    customerId: CUSTOMER_BASE + BigInt(i % 37) * 13n,
    email: `${first!.toLowerCase()}.${last!.toLowerCase()}@example.com`,
    name: `${first} ${last}`,
  }
}

function orderPlaced(rand: () => number, n: number, at: Date): { key: Buffer; value: Buffer } {
  const orderId = ORDER_BASE + BigInt(n) * 7n
  const customer = customerOf(Math.floor(rand() * 1000))
  const count = 1 + Math.floor(rand() * 3)
  const items = Array.from({ length: count }, () => {
    const [sku, name, unitPrice] = pick(rand, PRODUCTS)
    return { sku, name, qty: 1 + Math.floor(rand() * 3), unitPrice }
  })
  const totalCents = items.reduce(
    (sum, it) => sum + it.qty * Math.round(Number(it.unitPrice) * 100),
    0,
  )
  return {
    key: encodeWithSchema(KEY_SCHEMA, KEY_ID, orderId),
    value: encodeWithSchema(ORDER_PLACED, ORDER_PLACED_ID, {
      orderId,
      customer: {
        customerId: customer.customerId,
        email: customer.email,
        tier: pick(rand, TIERS),
      },
      items,
      total: money(totalCents),
      currency: "CHF",
      channel: pick(rand, CHANNELS),
      placedAt: BigInt(at.getTime()),
    }),
  }
}

function statusEvent(rand: () => number, n: number, at: Date): { key: Buffer; value: Buffer } {
  const orderId = ORDER_BASE + BigInt(n % 400) * 7n
  const key = encodeWithSchema(KEY_SCHEMA, KEY_ID, orderId)
  if (rand() < 0.3) {
    return {
      key,
      value: encodeWithSchema(SHIPMENT_DISPATCHED, SHIPMENT_ID, {
        orderId,
        carrier: pick(rand, CARRIERS),
        trackingId: `${pick(rand, CARRIERS).slice(0, 2).toUpperCase()}${String(Math.floor(rand() * 1e9)).padStart(9, "0")}CH`,
        parcels: 1 + Math.floor(rand() * 2),
        etaDays: 1 + Math.floor(rand() * 4),
        dispatchedAt: BigInt(at.getTime()),
      }),
    }
  }
  const idx = Math.floor(rand() * (STATUSES.length - 1))
  const cancelled = rand() < 0.08
  return {
    key,
    value: encodeWithSchema(STATUS_CHANGED, STATUS_CHANGED_ID, {
      orderId,
      from: STATUSES[idx],
      to: cancelled ? "CANCELLED" : STATUSES[idx + 1],
      reason: cancelled ? "customer request" : null,
      changedAt: BigInt(at.getTime()),
    }),
  }
}

function customerUpdated(rand: () => number, n: number, at: Date): { key: Buffer; value: Buffer } {
  const customer = customerOf(n)
  return {
    key: encodeWithSchema(KEY_SCHEMA, KEY_ID, customer.customerId),
    value: encodeWithSchema(CUSTOMER_UPDATED, CUSTOMER_ID, {
      ...customer,
      tier: pick(rand, TIERS),
      marketingOptIn: rand() < 0.4,
      addresses: {
        home: `${pick(rand, CITIES)}, ${1 + Math.floor(rand() * 90)} ${pick(rand, ["Bahnhofstrasse", "Rua Augusta", "Kawaramachi", "Rainbow St", "Torstraße"])}`,
        ...(rand() < 0.3
          ? { work: `${pick(rand, CITIES)}, PO Box ${100 + Math.floor(rand() * 900)}` }
          : {}),
      },
      updatedAt: BigInt(at.getTime()),
    }),
  }
}

/** Keyed partitioning, as a real producer does it: the same order always lands on the
 *  same partition, so a per-key replay stays in order. */
function partitionFor(key: Buffer, count: number): number {
  let h = 0
  for (const b of key) {
    h = (h * 31 + b) >>> 0
  }
  return h % count
}

interface TopicPlan {
  name: string
  partitions: number
  count: number
  /** Time between messages, ms — spreads the history over a plausible span. */
  gapMs: number
  low: bigint
  make: (rand: () => number, n: number, at: Date) => { key: Buffer; value: Buffer | null }
  headers?: (n: number) => Record<string, Buffer>
}

/** The epoch every seeded timestamp hangs off. Pinned by TOPIQ_DEMO_EPOCH (ISO 8601 or
 *  epoch millis) so a capture run is reproducible; otherwise now, so ages read naturally. */
export function demoEpoch(): Date {
  const raw = process.env["TOPIQ_DEMO_EPOCH"]
  if (!raw) {
    return new Date()
  }
  const millis = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
  if (Number.isNaN(millis)) {
    throw new Error(`TOPIQ_DEMO_EPOCH: "${raw}" is neither ISO 8601 nor epoch millis`)
  }
  return new Date(millis)
}

export function seedCluster(opts: { epoch: Date; scale?: number }): SeededCluster {
  const scale = opts.scale ?? 1
  const epoch = opts.epoch
  const plans: TopicPlan[] = [
    {
      name: ORDERS,
      partitions: 3,
      count: 400 * scale,
      gapMs: 47_000,
      low: 18_240n * BigInt(scale),
      make: orderPlaced,
      headers: (n) => ({
        "content-type": Buffer.from("application/avro"),
        "x-request-id": Buffer.from(`req-${(n * 2654435761) % 0xffffff}`.padEnd(14, "0")),
      }),
    },
    {
      name: STATUS,
      partitions: 2,
      count: 220 * scale,
      gapMs: 81_000,
      low: 7_910n * BigInt(scale),
      make: (rand, n, at) =>
        // One tombstone: a compacted topic's delete marker (spec 007 edge case).
        n === 40 ? { key: statusEvent(rand, n, at).key, value: null } : statusEvent(rand, n, at),
    },
    {
      name: CUSTOMERS,
      partitions: 1,
      count: 24 * scale,
      gapMs: 900_000,
      low: 1_105n,
      make: (rand, n, at) => {
        const m = customerUpdated(rand, n, at)
        // Framed with an id the registry does not know — the `decode failed` row.
        return n === 5
          ? { key: m.key, value: frame(UNREGISTERED_SCHEMA_ID, m.value.subarray(5)) }
          : m
      },
    },
    { name: INTERNAL, partitions: 1, count: 0, gapMs: 0, low: 0n, make: orderPlaced },
  ]

  const topics: SeededTopic[] = plans.map((plan) => {
    const rand = prng(plan.name.length * 7919 + plan.count)
    const partitions: SeededPartition[] = Array.from({ length: plan.partitions }, (_, id) => ({
      id,
      low: plan.low + BigInt(id) * 101n,
      log: [],
    }))
    // Oldest first, so offsets ascend with time within a partition as they do on a broker.
    const newest = epoch.getTime() - 30_000
    for (let n = 0; n < plan.count; n++) {
      const at = new Date(newest - (plan.count - 1 - n) * plan.gapMs + Math.floor(rand() * 900))
      const { key, value } = plan.make(rand, n, at)
      const partition = partitions[partitionFor(key, plan.partitions)]!
      partition.log.push({
        topic: plan.name,
        partition: partition.id,
        offset: partition.low + BigInt(partition.log.length),
        timestamp: at,
        key,
        value,
        headers: plan.headers?.(n) ?? {},
      })
    }
    return { name: plan.name, partitions }
  })

  const high = (topic: string, partition: number): bigint => {
    const p = topics.find((t) => t.name === topic)!.partitions[partition]!
    return p.low + BigInt(p.log.length)
  }
  const committed = (
    entries: [string, (bigint | null)[]][],
  ): Map<string, Map<number, bigint | null>> =>
    new Map(
      entries.map(([topic, lags]) => [
        topic,
        new Map(lags.map((lag, p) => [p, lag === null ? null : high(topic, p) - lag])),
      ]),
    )
  const member = (n: number, partitions: number[]): GroupMemberMeta => ({
    memberId: `consumer-${n}-8f3a1c${n}e-2b7d-4a91-9c0e-d41f2a6b7c${n}0`,
    clientId: `order-processor-${n}`,
    clientHost: `/10.4.2.${10 + n}`,
    partitions,
  })
  const groups: SeededGroup[] = [
    {
      groupId: "order-processor",
      state: "Stable",
      members: [member(1, [0, 1]), member(2, [2])],
      committed: committed([
        [ORDERS, [12n, 3n, 0n]],
        [STATUS, [1n, 0n]],
      ]),
    },
    {
      groupId: "analytics-sink",
      state: "Empty",
      members: [],
      committed: committed([
        [ORDERS, [151n, 149n, 160n]],
        [STATUS, [88n, 91n]],
        [CUSTOMERS, [2n]],
      ]),
    },
    {
      groupId: "legacy-reader",
      state: "Stable",
      members: [member(7, [0, 1])],
      // No commit on p2 ever: undefined lag renders `—`, and the total `+?` (spec 017).
      committed: committed([[ORDERS, [2_204n, 1_998n, null]]]),
    },
  ]

  // Live arrivals cycle their own generator so the history and the tail cannot collide
  // on order numbers; the sequence restarts per process, which is what determinism wants.
  const live = new Map(
    plans.filter((p) => p.count > 0).map((p) => [p.name, prng(0xdead + p.count)]),
  )
  const counters = new Map<string, number>()
  return {
    epoch,
    schemas: SCHEMAS,
    topics,
    groups,
    generate(topic, at) {
      const plan = plans.find((p) => p.name === topic)
      const rand = live.get(topic)
      if (!plan || !rand) {
        return null
      }
      const n = plan.count + (counters.get(topic) ?? 0)
      counters.set(topic, n - plan.count + 1)
      const { key, value } = plan.make(rand, n, at)
      return { topic, timestamp: at, key, value, headers: plan.headers?.(n) ?? {} }
    },
  }
}
