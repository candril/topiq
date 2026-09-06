import { groupSeekRefusal } from "@/kafka/groups.ts"
import { resolveStarts, type FetchRange, type PartitionStart } from "@/kafka/range.ts"
import type { ConsumeHandle, ConsumeOptions, KafkaClient, ProduceRecord } from "@/kafka/types.ts"
import type { ConsumerGroupMeta, PartitionMeta, RawMessage, TopicMeta } from "@/types.ts"
import type { SeededCluster, SeededPartition, SeededTopic } from "./seed.ts"

// The demo implementation of the seam (spec 027): a KafkaClient over the seeded in-memory
// log. Complete, not a subset — every method the real client has, including the writes,
// because a view that hits a missing method in demo mode is a view that cannot be
// screenshotted. Nothing in this file may import kafkajs: the demo must be unable to
// reach a network even by accident (seed.test.ts asserts it).

/** A follow sees a new message this often (spec 027 P2) — slow enough to read, fast
 *  enough that "following" visibly means something. */
const LIVE_EVERY_MS = 1500

/** History is delivered in chunks between timer ticks, not in one synchronous burst, so
 *  the table's per-frame flush (spec 007) interleaves and a window streams in the way a
 *  real one does. */
const CHUNK = 48

/** Plausible round-trips (spec 027 P2). Instant answers make the loading indicators
 *  unreachable and the tool feel unlike itself; TOPIQ_DEMO_LATENCY=0 removes them for
 *  tests. One place, so there is one switch. */
const LATENCY_MS = {
  connect: 350,
  list: 160,
  describe: 60,
  window: 220,
  produce: 90,
  group: 130,
  chunk: 12,
} as const

export function createDemoClient(seed: SeededCluster): KafkaClient {
  const latency = process.env["TOPIQ_DEMO_LATENCY"] !== "0"
  const wait = (key: keyof typeof LATENCY_MS): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, latency ? LATENCY_MS[key] : 0))

  const topics = new Map(seed.topics.map((t) => [t.name, t]))
  const groups = new Map(seed.groups.map((g) => [g.groupId, g]))

  // The demo's clock runs from the seed epoch, so a produced message's timestamp sits
  // just after the newest seeded one whether or not the epoch was pinned.
  const started = performance.now()
  const clock = (): Date => new Date(seed.epoch.getTime() + (performance.now() - started))

  let connected = false
  async function connect(): Promise<void> {
    if (!connected) {
      await wait("connect")
      connected = true
    }
  }

  function topicOrThrow(name: string): SeededTopic {
    const topic = topics.get(name)
    if (!topic) {
      throw new Error(`topic "${name}" does not exist`)
    }
    return topic
  }

  const high = (p: SeededPartition): bigint => p.low + BigInt(p.log.length)
  const meta = (topic: SeededTopic): PartitionMeta[] =>
    topic.partitions.map((p) => ({ id: p.id, low: p.low, high: high(p), leader: (p.id % 3) + 1 }))
  const describe = (topic: SeededTopic): TopicMeta => ({
    name: topic.name,
    partitions: meta(topic),
  })
  const groupMeta = (groupId: string, topic: SeededTopic): ConsumerGroupMeta => {
    const group = groups.get(groupId)
    const committed = group?.committed.get(topic.name)
    return {
      groupId,
      state: group?.state ?? "Unknown",
      memberCount: group?.members.length ?? 0,
      members: group?.members ?? [],
      offsets: meta(topic).map((p) => {
        const offset = committed?.get(p.id) ?? null
        return {
          partition: p.id,
          committed: offset,
          high: p.high,
          lag: offset === null ? null : p.high - offset,
        }
      }),
    }
  }

  function resolveRange(
    topic: SeededTopic,
    range: FetchRange,
    partitions: PartitionMeta[],
  ): PartitionStart[] {
    if (range.kind !== "timestamp") {
      return resolveStarts(range, partitions)
    }
    // Like the broker: the first offset at or after the timestamp, or nothing from this
    // partition — never a fallback to low (spec 009).
    const t = range.timestamp.getTime()
    return partitions.map((pm) => {
      const p = topic.partitions[pm.id]!
      const index = p.log.findIndex((m) => m.timestamp.getTime() >= t)
      return { partition: pm.id, offset: index === -1 ? null : p.low + BigInt(index) }
    })
  }

  // Follow consumers register here; produce and the live ticker feed them.
  const listeners = new Set<(m: RawMessage) => void>()

  function append(
    topic: SeededTopic,
    record: Omit<RawMessage, "partition" | "offset">,
    partition?: number,
  ): { partition: number; offset: bigint } {
    const target =
      partition === undefined
        ? topic.partitions[hashPartition(record.key, topic.partitions.length)]!
        : topic.partitions[partition]
    if (!target) {
      throw new Error(`${topic.name} has no partition ${partition}`)
    }
    const message: RawMessage = { ...record, partition: target.id, offset: high(target) }
    target.log.push(message)
    for (const listener of listeners) {
      listener(message)
    }
    return { partition: target.id, offset: message.offset }
  }

  // One ticker for every followed topic, alive only while something follows: an idle
  // interval per client would keep the process up after the last consumer stopped.
  const followed = new Map<string, number>()
  let live: ReturnType<typeof setInterval> | null = null
  function follow(name: string, delta: 1 | -1): void {
    const count = (followed.get(name) ?? 0) + delta
    if (count <= 0) {
      followed.delete(name)
    } else {
      followed.set(name, count)
    }
    if (followed.size > 0 && live === null) {
      live = setInterval(() => {
        for (const topic of followed.keys()) {
          const next = seed.generate(topic, clock())
          if (next) {
            append(topicOrThrow(topic), next)
          }
        }
      }, LIVE_EVERY_MS)
    } else if (followed.size === 0 && live !== null) {
      clearInterval(live)
      live = null
    }
  }

  const timers = new Set<ReturnType<typeof setTimeout>>()
  function later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
  }

  return {
    async listTopics() {
      await connect()
      await wait("list")
      return seed.topics.map((t) => ({ name: t.name, partitionCount: t.partitions.length }))
    },

    async fetchWatermarks(names) {
      await connect()
      await wait("list")
      return names.flatMap((name) => {
        const topic = topics.get(name)
        return topic ? [describe(topic)] : []
      })
    },

    async describeTopic(name) {
      await connect()
      await wait("describe")
      return describe(topicOrThrow(name))
    },

    async consume(name, opts: ConsumeOptions, onMessage): Promise<ConsumeHandle> {
      await connect()
      await wait("window")
      const topic = topicOrThrow(name)
      const isFollow = opts.follow ?? false
      const all = meta(topic)
      const scoped = opts.partition === undefined ? all : all.filter((p) => p.id === opts.partition)
      const scopedIds = new Set(scoped.map((p) => p.id))
      const starts =
        opts.startAt === undefined
          ? resolveRange(topic, opts.range, scoped)
          : opts.startAt.filter((s) => scopedIds.has(s.partition))
      // A window is a snapshot: what was there when it opened, so a produce during the
      // read cannot make it endless. A tail reads the live high instead.
      const snapshot = new Map(scoped.map((p) => [p.id, p.high]))
      const cursors = new Map(
        starts.filter((s) => s.offset !== null).map((s) => [s.partition, s.offset!]),
      )
      for (const [id, offset] of cursors) {
        if (offset >= (snapshot.get(id) ?? 0n) && !isFollow) {
          cursors.delete(id)
        }
      }
      if (cursors.size === 0 && !isFollow) {
        return { done: Promise.resolve(), stop: async () => {} }
      }

      let delivered = 0
      let stopped = false
      let following = false
      let resolveDone: () => void = () => {}
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      const listener = (m: RawMessage): void => {
        if (stopped || m.topic !== name || !scopedIds.has(m.partition)) {
          return
        }
        delivered++
        onMessage(m)
        if (delivered >= opts.limit) {
          void stop()
        }
      }
      const stop = async (): Promise<void> => {
        if (stopped) {
          return
        }
        stopped = true
        if (following) {
          listeners.delete(listener)
          follow(name, -1)
        }
        resolveDone()
      }

      const pump = (): void => {
        if (stopped) {
          return
        }
        let sent = 0
        let progressed = true
        while (sent < CHUNK && progressed && delivered < opts.limit) {
          progressed = false
          for (const [id, offset] of cursors) {
            const partition = topic.partitions[id]!
            const limit = isFollow ? high(partition) : snapshot.get(id)!
            if (offset >= limit) {
              cursors.delete(id)
              continue
            }
            onMessage(partition.log[Number(offset - partition.low)]!)
            cursors.set(id, offset + 1n)
            delivered++
            sent++
            progressed = true
            if (delivered >= opts.limit) {
              break
            }
          }
        }
        if (delivered >= opts.limit) {
          void stop()
          return
        }
        if (cursors.size > 0) {
          later(pump, latency ? LATENCY_MS.chunk : 0)
          return
        }
        if (!isFollow) {
          void stop()
          return
        }
        // History drained: hand over to live arrivals. No await between the last read and
        // this registration, so nothing produced in between is skipped (spec 012).
        following = true
        listeners.add(listener)
        follow(name, 1)
      }
      later(pump, 0)
      return { done, stop }
    },

    async produce(name, records: ProduceRecord[]) {
      await connect()
      await wait("produce")
      const topic = topicOrThrow(name)
      return records.map((r) =>
        append(
          topic,
          { topic: name, timestamp: clock(), key: r.key, value: r.value, headers: r.headers },
          r.partition,
        ),
      )
    },

    async listGroups() {
      await connect()
      await wait("group")
      return seed.groups.map((g) => ({
        groupId: g.groupId,
        state: g.state,
        memberCount: g.members.length,
      }))
    },

    async describeGroup(groupId, name): Promise<ConsumerGroupMeta> {
      await connect()
      await wait("group")
      return groupMeta(groupId, topicOrThrow(name))
    },

    async describeGroups(groupIds, name): Promise<(ConsumerGroupMeta | null)[]> {
      await connect()
      // One wait for the batch, as the real client pays one DescribeGroups (spec 029).
      await wait("group")
      const topic = topicOrThrow(name)
      return groupIds.map((groupId) => groupMeta(groupId, topic))
    },

    async resolveOffsets(name, range) {
      await connect()
      await wait("describe")
      const topic = topicOrThrow(name)
      return resolveRange(topic, range, meta(topic))
    },

    async setGroupOffsets(groupId, name, range) {
      await connect()
      await wait("group")
      const group = groups.get(groupId)
      // Same rule, same wording, same moment as the real client: immediately before the
      // write, because a group can rejoin between the confirm opening and the keystroke.
      const refusal = groupSeekRefusal(
        groupId,
        group?.state ?? "Unknown",
        group?.members.length ?? 0,
      )
      if (refusal !== null) {
        throw new Error(refusal)
      }
      const topic = topicOrThrow(name)
      const committed = group!.committed.get(name) ?? new Map<number, bigint | null>()
      for (const s of resolveRange(topic, range, meta(topic))) {
        if (s.offset !== null) {
          committed.set(s.partition, s.offset)
        }
      }
      group!.committed.set(name, committed)
    },

    async disconnect() {
      for (const timer of timers) {
        clearTimeout(timer)
      }
      timers.clear()
      if (live !== null) {
        clearInterval(live)
        live = null
      }
      followed.clear()
      listeners.clear()
      connected = false
    },
  }
}

/** Keyed partitioning for an unpartitioned produce — the same key lands on the same
 *  partition, as the default partitioner would. A null key round-robins on offset parity. */
function hashPartition(key: Buffer | null, count: number): number {
  if (key === null || key.length === 0) {
    return Math.floor(performance.now()) % count
  }
  let h = 0
  for (const b of key) {
    h = (h * 31 + b) >>> 0
  }
  return h % count
}
