import { readFileSync } from "node:fs"
import { AssignerProtocol, CompressionCodecs, CompressionTypes, Kafka } from "kafkajs"
import snappyCodec from "kafkajs-snappy"
import type { Admin, Consumer, Producer, SASLOptions } from "kafkajs"
import type { ClusterProfile } from "@/config/schema.ts"
import type {
  ConsumerGroupMeta,
  GroupOverview,
  PartitionMeta,
  TopicMeta,
  TopicSummary,
} from "@/types.ts"
import type { ConsumeHandle, ConsumeOptions, KafkaClient, ProduceRecord } from "./types.ts"
import { groupSeekRefusal } from "./groups.ts"
import { clientId, ephemeralGroupId, processIdentity } from "./identity.ts"
import { kafkaLogging } from "./log.ts"
import { mapLimit } from "./pool.ts"
import { type FetchRange, type PartitionStart, resolveStarts } from "./range.ts"

// Small on purpose: kafkajs serialises admin requests anyway, and a wide window is what
// provokes the empty-response race described on describeRetrying (spec 003).
const WATERMARK_CONCURRENCY = 8
const OFFSET_FETCH_CONCURRENCY = 8

// kafkajs implements gzip and nothing else. Many clusters produce snappy batches,
// and an unregistered codec does not degrade — it throws KafkaJSNotImplemented inside the
// fetch decoder and kills the consumer runner. Pure-JS codec, registered once (spec 003).
CompressionCodecs[CompressionTypes.Snappy] = snappyCodec

// kafkajs implementation of the seam (spec 003; chosen after the Confluent native client
// crashed Bun on import). kafkajs cannot read without a consumer group, so reads join an
// ephemeral group with autoCommit off — no offsets are ever committed (spec 009).
//
// Auto topic creation is off on every path: kafkajs defaults it to *on* for producers and
// consumers, and a broker with auto.create.topics.enable would turn a mistyped topic name
// into a new topic with broker-default partitions (spec 029).

export function createKafkaClient(profile: ClusterProfile, password: string): KafkaClient {
  const identity = processIdentity()
  const kafka = new Kafka({
    clientId: clientId(identity),
    brokers: profile.brokers,
    ssl: profile.caCert ? { ca: [readFileSync(profile.caCert, "utf8")] } : true,
    // kafkajs discriminates SASLOptions on the mechanism *literal*, so a profile whose
    // mechanism is the scram-256/512 union needs the assertion — both arms take the
    // same username/password shape.
    sasl: { ...profile.sasl, password } as SASLOptions,
    // kafkajs's 1 s default tears down a TLS handshake that is merely slow — a remote
    // cluster behind a self-signed CA routinely is — and retries with backoff, which shows
    // up as a random multi-second stall rather than as an error (spec 029).
    connectionTimeout: 5000,
    requestTimeout: 30000,
    ...kafkaLogging(),
  })

  let admin: Admin | null = null
  let producer: Producer | null = null
  const consumers = new Set<Consumer>()

  async function getAdmin(): Promise<Admin> {
    if (!admin) {
      admin = kafka.admin()
      await admin.connect()
    }
    return admin
  }

  async function fetchPartitions(topic: string): Promise<PartitionMeta[]> {
    const offsets = await (await getAdmin()).fetchTopicOffsets(topic)
    return offsets.map((o) => ({ id: o.partition, low: BigInt(o.low), high: BigInt(o.high) }))
  }

  // Under concurrent admin load kafkajs intermittently reads an empty ListOffsets response
  // and throws "Cannot destructure property 'partitions'" for a topic that answers fine on
  // its own. One retry clears it; a second failure is real and propagates (spec 003).
  async function describeRetrying(topic: string): Promise<PartitionMeta[]> {
    try {
      return await fetchPartitions(topic)
    } catch {
      return await fetchPartitions(topic)
    }
  }

  async function topicLeaders(names: string[]): Promise<Map<string, Map<number, number>>> {
    const metadata = await (await getAdmin()).fetchTopicMetadata({ topics: names })
    return new Map(
      metadata.topics.map((t) => [
        t.name,
        new Map(t.partitions.map((p) => [p.partitionId, p.leader])),
      ]),
    )
  }

  async function resolveRange(
    topic: string,
    range: FetchRange,
    partitions: PartitionMeta[],
  ): Promise<{ partition: number; offset: bigint | null }[]> {
    if (range.kind !== "timestamp") {
      return resolveStarts(range, partitions)
    }
    const byTs = await (
      await getAdmin()
    ).fetchTopicOffsetsByTimestamp(topic, range.timestamp.getTime())
    // The broker answers -1 when a partition has nothing at/after the timestamp: that
    // partition contributes no rows — falling back to low would lie (spec 009).
    return byTs.map((o) => ({
      partition: o.partition,
      offset: o.offset === "-1" ? null : BigInt(o.offset),
    }))
  }

  return {
    async listTopics(): Promise<TopicSummary[]> {
      const a = await getAdmin()
      // Internal topics included: hiding them is the view's toggle, not the seam's call
      // (spec 006 P2).
      const names = await a.listTopics()
      if (names.length === 0) {
        return []
      }
      const metadata = await a.fetchTopicMetadata({ topics: names })
      return metadata.topics.map((t) => ({ name: t.name, partitionCount: t.partitions.length }))
    },

    async fetchWatermarks(names: string[]): Promise<TopicMeta[]> {
      if (names.length === 0) {
        return []
      }
      const leaders = await topicLeaders(names)
      let firstError: unknown = null
      const measured = await mapLimit(names, WATERMARK_CONCURRENCY, async (name) => {
        try {
          return {
            name,
            partitions: (await describeRetrying(name)).map((p) => ({
              ...p,
              leader: leaders.get(name)?.get(p.id),
            })),
          }
        } catch (error) {
          firstError ??= error
          return null
        }
      })
      const ok = measured.filter((m) => m !== null)
      // All of them failing is a fault, not a flake: surface it rather than painting a
      // list of unmeasurable topics (nfr/004).
      if (ok.length === 0 && firstError !== null) {
        throw firstError
      }
      return ok
    },

    async describeTopic(name: string): Promise<TopicMeta> {
      return { name, partitions: await describeRetrying(name) }
    },

    async consume(topic, opts: ConsumeOptions, onMessage): Promise<ConsumeHandle> {
      const follow = opts.follow ?? false
      const all = await fetchPartitions(topic)
      const scoped = opts.partition === undefined ? all : all.filter((p) => p.id === opts.partition)
      const scopedIds = new Set(scoped.map((p) => p.id))
      const starts =
        opts.startAt === undefined
          ? await resolveRange(topic, opts.range, scoped)
          : opts.startAt.filter((s) => scopedIds.has(s.partition))
      const highs = new Map(scoped.map((p) => [p.id, p.high]))
      // Guard below-start deliveries too: kafkajs can hand out messages from the group's
      // default position in the gap before seek() lands, which would leak rows below the
      // requested range into the window and burn the limit.
      const startAt = new Map(
        starts.filter((s) => s.offset !== null).map((s) => [s.partition, s.offset!]),
      )
      const pending = new Set(
        starts
          .filter((s) => s.offset !== null && s.offset < (highs.get(s.partition) ?? 0n))
          .map((s) => s.partition),
      )

      const groupId = ephemeralGroupId(identity)
      const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false })
      consumers.add(consumer)

      let delivered = 0
      let resolveDone: () => void
      let rejectDone: (error: unknown) => void
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve
        rejectDone = reject
      })
      // kafkajs reports a fatal runner failure — an unimplemented codec, a payload it
      // cannot decode — through the CRASH event, never through `run()`'s promise. Without
      // this the consumer just stops delivering and the table spins on "loading" with
      // nothing said (nfr/004).
      consumer.on(consumer.events.CRASH, ({ payload }) => rejectDone(payload.error))
      // Memoised, not re-entrant: `done.then(stop)` and an explicit stop() must share one
      // disconnect, and the second caller has to await the first rather than return early
      // while the socket is still closing (spec 001 — a leaked socket keeps Bun alive).
      let stopping: Promise<void> | null = null
      const stop = (): Promise<void> => {
        stopping ??= (async () => {
          consumers.delete(consumer)
          // Settle `done` too, or a caller awaiting it after stop() waits forever.
          resolveDone()
          await consumer.disconnect()
        })()
        return stopping
      }
      // A window with nothing left to read is finished — but that is exactly where follow
      // starts, so an empty pending set only ends a non-following read.
      if (pending.size === 0 && !follow) {
        await stop()
        return { done: Promise.resolve(), stop: async () => {} }
      }

      await consumer.connect()
      await consumer.subscribe({ topic })
      // The end of a partition is read off the fetch, never off a delivered record: on a
      // transactional topic the record at high−1 is a commit marker, and kafkajs filters
      // markers and aborted records out *before* the batch callback — a batch that held only
      // those never reaches it at all. END_BATCH_PROCESS fires for every batch either way,
      // with the last offset the fetch accounted for (spec 029). Compaction can still leave
      // nothing at all at the tail (a removed tombstone); that fetch comes back empty and
      // kafkajs announces nothing for it — closed under 029 P2 with the raw fetch path.
      const endOfPartition = (partition: number, lastOffset: bigint): void => {
        if (follow || !pending.has(partition)) {
          return
        }
        const high = highs.get(partition)
        if (high !== undefined && lastOffset >= high - 1n) {
          pending.delete(partition)
        }
        if (pending.size === 0) {
          resolveDone()
        }
      }
      consumer.on(consumer.events.END_BATCH_PROCESS, ({ payload }) =>
        endOfPartition(payload.partition, BigInt(payload.lastOffset)),
      )
      void consumer
        .run({
          autoCommit: false,
          eachBatch: async ({ batch }) => {
            const { partition } = batch
            // Following, every scoped partition stays open: `pending` only tracks which of
            // them still has history to read, and a tail starts with none of them there.
            if (!(follow ? scopedIds.has(partition) : pending.has(partition))) {
              return
            }
            const start = startAt.get(partition)
            if (start === undefined) {
              return
            }
            for (const message of batch.messages) {
              if (delivered >= opts.limit) {
                break
              }
              const offset = BigInt(message.offset)
              if (offset < start) {
                continue
              }
              delivered++
              onMessage({
                topic,
                partition,
                offset,
                timestamp: new Date(Number(message.timestamp)),
                key: message.key,
                value: message.value,
                headers: normalizeHeaders(message.headers),
              })
            }
            if (delivered >= opts.limit) {
              resolveDone()
            }
          },
        })
        .catch(() => resolveDone())
      for (const s of starts) {
        if (s.offset !== null) {
          consumer.seek({ topic, partition: s.partition, offset: s.offset.toString() })
        }
      }
      // Both arms: a crashed consume must still disconnect, and `done` is the caller's to
      // handle — attaching only a fulfilment handler would leave its rejection unhandled.
      void done.then(stop, stop)
      return { done, stop }
    },

    async produce(topic, records: ProduceRecord[]) {
      if (!producer) {
        producer = kafka.producer({ allowAutoTopicCreation: false })
        await producer.connect()
      }
      const result = await producer.send({
        topic,
        messages: records.map((r) => ({
          key: r.key,
          value: r.value,
          headers: r.headers,
          partition: r.partition,
        })),
      })
      return result.map((r) => ({ partition: r.partition, offset: BigInt(r.baseOffset ?? "-1") }))
    },

    async listGroups(): Promise<GroupOverview[]> {
      const a = await getAdmin()
      const { groups } = await a.listGroups()
      if (groups.length === 0) {
        return []
      }
      const described = await a.describeGroups(groups.map((g) => g.groupId))
      return described.groups.map((g) => ({
        groupId: g.groupId,
        state: g.state,
        memberCount: g.members.length,
      }))
    },

    async describeGroup(groupId, topic): Promise<ConsumerGroupMeta> {
      const a = await getAdmin()
      const [described, committed, partitions] = await Promise.all([
        a.describeGroups([groupId]),
        a.fetchOffsets({ groupId, topics: [topic] }),
        fetchPartitions(topic),
      ])
      return groupMeta(
        groupId,
        topic,
        described.groups[0],
        committedOffsets(committed, topic),
        partitions,
      )
    },

    async describeGroups(groupIds, topic): Promise<(ConsumerGroupMeta | null)[]> {
      if (groupIds.length === 0) {
        return []
      }
      const a = await getAdmin()
      const [described, partitions] = await Promise.all([
        a.describeGroups(groupIds),
        fetchPartitions(topic),
      ])
      const byId = new Map(described.groups.map((g) => [g.groupId, g]))
      // OffsetFetch is the one request that is per group — its coordinator answers for
      // that group alone. Bounded so a cluster with hundreds of groups is a queue, not a
      // socket storm.
      return await mapLimit(groupIds, OFFSET_FETCH_CONCURRENCY, async (groupId) => {
        try {
          const committed = await a.fetchOffsets({ groupId, topics: [topic] })
          return groupMeta(
            groupId,
            topic,
            byId.get(groupId),
            committedOffsets(committed, topic),
            partitions,
          )
        } catch {
          return null
        }
      })
    },

    async resolveOffsets(topic, range): Promise<PartitionStart[]> {
      return await resolveRange(topic, range, await fetchPartitions(topic))
    },

    async setGroupOffsets(groupId, topic, range): Promise<void> {
      const a = await getAdmin()
      // Spec 018: refuse unless the group is empty — checked here, immediately before the
      // write, not only when a view loaded. The wording is groups.ts', so the preview's
      // refusal and this one cannot say different things about the same rule.
      const described = await a.describeGroups([groupId])
      const group = described.groups[0]
      const refusal = groupSeekRefusal(
        groupId,
        group?.state ?? "Unknown",
        group?.members.length ?? 0,
      )
      if (refusal !== null) {
        throw new Error(refusal)
      }
      const partitions = await fetchPartitions(topic)
      const starts = await resolveRange(topic, range, partitions)
      await a.setOffsets({
        groupId,
        topic,
        partitions: starts
          .filter((s) => s.offset !== null)
          .map((s) => ({ partition: s.partition, offset: s.offset!.toString() })),
      })
    },

    async disconnect(): Promise<void> {
      await Promise.all([...consumers].map((c) => c.disconnect()))
      consumers.clear()
      if (producer) {
        await producer.disconnect()
      }
      if (admin) {
        await admin.disconnect()
      }
      producer = null
      admin = null
    },
  }
}

type DescribedGroup = Awaited<ReturnType<Admin["describeGroups"]>>["groups"][number]
type FetchedOffsets = Awaited<ReturnType<Admin["fetchOffsets"]>>

function committedOffsets(fetched: FetchedOffsets, topic: string): Map<number, string> {
  return new Map(
    (fetched.find((t) => t.topic === topic)?.partitions ?? []).map((p) => [p.partition, p.offset]),
  )
}

/** One shape for a group whether it was described alone or in a batch. A group the broker
 *  did not describe (deleted between the listing and now) is "Unknown" with no members —
 *  its committed offsets, if any, are still worth showing. */
function groupMeta(
  groupId: string,
  topic: string,
  group: DescribedGroup | undefined,
  committed: Map<number, string>,
  partitions: PartitionMeta[],
): ConsumerGroupMeta {
  return {
    groupId,
    state: group?.state ?? "Unknown",
    memberCount: group?.members.length ?? 0,
    members: (group?.members ?? []).map((m) => ({
      memberId: m.memberId,
      clientId: m.clientId,
      clientHost: m.clientHost,
      partitions: assignedPartitions(m.memberAssignment, topic),
    })),
    offsets: partitions.map((p) => {
      const raw = committed.get(p.id)
      // "-1" = never committed: lag is undefined, not zero (spec 017)
      const committedOffset = raw === undefined || raw === "-1" ? null : BigInt(raw)
      return {
        partition: p.id,
        committed: committedOffset,
        high: p.high,
        lag: committedOffset === null ? null : p.high - committedOffset,
      }
    }),
  }
}

/** Partitions of `topic` inside a member's assignment blob (spec 017 P2). The blob is the
 *  assignor's own encoding, so a custom assignor can produce something kafkajs cannot read
 *  — an unreadable assignment is reported as "none listed", never as a decode crash that
 *  would take the whole group list down with it. */
function assignedPartitions(assignment: Buffer, topic: string): number[] {
  try {
    const decoded = AssignerProtocol.MemberAssignment.decode(assignment)
    return decoded?.assignment?.[topic] ?? []
  } catch {
    return []
  }
}

function normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (Buffer.isBuffer(v)) {
      out[k] = v
    } else if (typeof v === "string") {
      out[k] = Buffer.from(v)
    } else if (v !== undefined) {
      out[k] = Buffer.from(String(v))
    }
  }
  return out
}
