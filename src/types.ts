// Domain types every view depends on (spec 004). Raw bytes are retained alongside the
// decoded form — byte-exact replay (spec 013) is impossible without them.

export interface RawMessage {
  topic: string
  partition: number
  offset: bigint
  timestamp: Date
  key: Buffer | null
  value: Buffer | null
  headers: Record<string, Buffer>
}

export interface DecodedMessage extends RawMessage {
  decodedKey: unknown
  decodedValue: unknown
  keySchemaId?: number
  valueSchemaId?: number
  decodeError?: string
}

export interface PartitionMeta {
  id: number
  low: bigint
  high: bigint
  /** Broker id of the partition leader — only known when metadata was fetched (spec 006 P2). */
  leader?: number
}

export interface TopicMeta {
  name: string
  partitions: PartitionMeta[]
}

/** What one metadata round-trip yields for every topic at once (spec 006). Watermarks are
 *  deliberately absent: they cost a request per topic, which a ~1900-topic cluster cannot
 *  afford up front ([003](../specs/003-kafka-client-seam.md)) — the list measures the rows
 *  it shows. */
export interface TopicSummary {
  name: string
  partitionCount: number
}

export interface PartitionOffset {
  partition: number
  committed: bigint | null
  high: bigint
  /** null when the group never committed on this partition — undefined lag is not zero lag */
  lag: bigint | null
}

export interface GroupMemberMeta {
  memberId: string
  clientId: string
  clientHost: string
  /** Partitions of the described topic this member owns. Empty when the member holds only
   *  other topics, or when the broker's assignment blob could not be decoded — either way
   *  "no partitions listed", never "idle". */
  partitions: number[]
}

/** Cheap group listing (spec 017 P1): everything the broker hands back without a
 *  per-group, per-topic offset fetch. Lag is not in here on purpose — it costs a
 *  round-trip per group and the list renders before it arrives. */
export interface GroupOverview {
  groupId: string
  state: string
  memberCount: number
}

export interface ConsumerGroupMeta extends GroupOverview {
  offsets: PartitionOffset[]
  members: GroupMemberMeta[]
}
