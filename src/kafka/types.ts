import type {
  ConsumerGroupMeta,
  GroupOverview,
  RawMessage,
  TopicMeta,
  TopicSummary,
} from "@/types.ts"
import type { FetchRange, PartitionStart } from "./range.ts"

// The seam (spec 003): the UI and everything above depends on this interface, never on
// kafkajs. index.tsx is the one place an implementation is chosen.

export interface ConsumeOptions {
  range: FetchRange
  /** Hard cap on delivered messages — the bounded-buffer contract (spec 012). In follow
   *  mode the caller passes Infinity: memory is bounded by the display buffer, and a
   *  consumer that quietly stopped at a limit would look exactly like a quiet topic. */
  limit: number
  /** Restrict to one partition (spec 009 P2). */
  partition?: number
  /** Start offsets that override whatever `range` would resolve to. Follow resumes at the
   *  end of the window already on screen (spec 012); re-resolving the range against
   *  watermarks that have since moved would skip or repeat the rows in between. */
  startAt?: PartitionStart[]
  /** Keep reading past the high watermark instead of stopping at the end of the range:
   *  `done` then resolves only at `limit` or on `stop()` (spec 012). */
  follow?: boolean
}

export interface ConsumeHandle {
  /** Resolves when limit is reached, the range is exhausted, or stop() is called.
   *  **Rejects** when the consumer dies mid-read — the caller must render that rather than
   *  wait on a promise that will never settle ([nfr/004](../../specs/nfr/004-reliability-and-errors.md)). */
  done: Promise<void>
  stop(): Promise<void>
}

export interface ProduceRecord {
  key: Buffer | null
  value: Buffer | null
  headers: Record<string, Buffer>
  partition?: number
}

export interface KafkaClient {
  /** Names and partition counts for every topic — one metadata round-trip, no watermarks. */
  listTopics(): Promise<TopicSummary[]>
  /** Watermarks for a named subset, so the topic list pays only for the rows it shows
   *  (spec 006). Topics whose watermarks could not be read are omitted rather than
   *  guessed; the call rejects only when *every* one failed, so a real fault (auth, a dead
   *  connection) still surfaces. */
  fetchWatermarks(names: string[]): Promise<TopicMeta[]>
  describeTopic(name: string): Promise<TopicMeta>
  /** `onMessage` may return a promise to ask the fetch to wait — backpressure for a read
   *  that must not drop (spec 030). The kafkajs client awaits it per message; the demo
   *  client's log is already in memory, so it has nothing to hold back and ignores it. */
  consume(
    topic: string,
    opts: ConsumeOptions,
    onMessage: (m: RawMessage) => void | Promise<void>,
  ): Promise<ConsumeHandle>
  /** Raw bytes in, raw bytes out — the produce path never decodes (spec 013). */
  produce(topic: string, records: ProduceRecord[]): Promise<{ partition: number; offset: bigint }[]>
  listGroups(): Promise<GroupOverview[]>
  describeGroup(groupId: string, topic: string): Promise<ConsumerGroupMeta>
  /** `describeGroup` for a whole list: one `DescribeGroups` and one watermark read for all
   *  of them, an `OffsetFetch` per group (spec 029). One entry per id, in input order —
   *  `null` where that group's offsets could not be read, so the caller keeps the row with
   *  unknown lag instead of dropping a group that exists ([017](../../specs/017-consumer-groups.md)). */
  describeGroups(groupIds: string[], topic: string): Promise<(ConsumerGroupMeta | null)[]>
  /** Where a range lands per partition, without reading anything. Timestamp ranges need a
   *  broker lookup, which is why this is on the seam rather than in `range.ts`: the seek
   *  preview has to show the offsets it is about to commit (spec 018). */
  resolveOffsets(topic: string, range: FetchRange): Promise<PartitionStart[]>
  /**
   * Move a group's committed offsets (spec 018).
   *
   * Implementations **must** refuse unless the group is `Empty`, checked here rather than
   * by the caller: this is the last moment before the write, and a group can rejoin
   * between a confirm dialog opening and its keystroke landing. `groupSeekRefusal` in
   * `groups.ts` is the one wording of that rule.
   */
  setGroupOffsets(groupId: string, topic: string, range: FetchRange): Promise<void>
  disconnect(): Promise<void>
}
