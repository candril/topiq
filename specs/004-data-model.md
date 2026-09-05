# Data Model

**Status**: Done — `src/types.ts`, exercised by the decode tests and the live smoke

## Description

The domain types every view depends on. Shaped so the UI never needs to know which Kafka
library or serialisation format produced them, and so the raw bytes survive alongside the
decoded value — the precondition for byte-exact replay.

## Capabilities

### P1 — Must Have

- `RawMessage`: `{ topic, partition, offset: bigint, timestamp: Date, key: Buffer|null,
  value: Buffer|null, headers: Record<string, Buffer> }`. Offsets are `bigint`, not
  `number` ([nfr/006](./nfr/006-data-fidelity.md)).
- `DecodedMessage`: a `RawMessage` **plus** `{ decodedKey, decodedValue, schemaId?,
  decodeError? }`. The raw buffers are retained, never replaced.
- A tombstone (`value === null`) is a first-class message, not an error or a blank row.
- `TopicMeta`: `{ name, partitions: PartitionMeta[] }`, `PartitionMeta`:
  `{ id, low: bigint, high: bigint, leader? }`.
- `ConsumerGroupMeta`: `{ groupId, state, members, offsets: PartitionOffset[] }` with
  `lag: bigint` per partition.

### P2 — Should Have

- `decodeError` carries the failure without discarding the message — an undecodable
  message still renders its metadata and hex ([008](./008-message-detail.md)).

## Out of Scope

- Column inference over decoded values — [007](./007-message-table.md).
- Persistence. These are in-memory snapshots for a session
  ([000](./000-vision.md) Non-Goals).

## Technical Notes

- Views import **only** from `src/types.ts`. The Kafka seam
  ([003](./003-kafka-client-seam.md)) produces `RawMessage`; the decode layer
  ([005](./005-schema-registry.md)) lifts it to `DecodedMessage`.
- `bigint` for offsets and lag is not pedantry: a partition high-watermark exceeds 2^53 on
  busy topics, and lag arithmetic on `Number` silently rounds.

## File Structure

| File | Change |
|------|--------|
| `src/types.ts` | All domain types |
