# Byte-Exact Replay

**Status**: **Done** — P1 built and **verified live** on 2026-08-28 against
`orders-test`: a replay of `p2@100` landed as `p2@101`, key and value bytes identical
(208 B value), original untouched, new timestamp and offset as the dialog promised. P2
(multi-message, partition choice) and P3 open.
## Description

Select a message, re-produce it to the same topic with the **identical key, value and
header bytes**. No decode/re-encode round trip, so the embedded schema id stays valid and
there is zero drift risk. This is the feature no org tool provides.

## Capabilities

### P1 — Must Have

- Re-produce the focused message's raw `key`, `value` and `headers` buffers verbatim
  ([004](./004-data-model.md) keeps them alongside the decoded form).
- Target the **same topic on the same cluster** — the only case where byte-exactness holds
  ([nfr/006](./nfr/006-data-fidelity.md), invariant 3).
- Gated by `allow_write` on the profile, plus a confirm dialog naming topic, cluster,
  environment and the message's age ([019](./019-write-safety.md),
  [002](./002-cluster-config.md)).
- A tombstone replays as a tombstone (null value preserved, key intact).
- Report the produced partition + offset on success.

### P2 — Should Have

- Replay a multi-message selection in original order.
- Choose the target partition, or let the key's partitioner decide (default: let it decide,
  so key-based routing stays consistent).

### P3 — Nice to Have

- Replay everything matching the active filter ([010](./010-filter-bar.md)).

## Out of Scope

- Editing before replay — [014](./014-edit-and-replay.md).
- A different cluster — [016](./016-cross-cluster-copy.md), which *cannot* be byte-exact.

## Technical Notes

- The produce path takes `Buffer`s and must never route through the decoder. Any code path
  that decodes and re-encodes for a same-cluster replay is a bug, even if the output
  happens to match.
- Original timestamp is **not** preserved: the replayed message gets a new timestamp and
  offset. That is inherent to Kafka; the confirm dialog should not imply otherwise.
- Replaying a snapshot-style message re-applies stale state downstream. That is the
  danger the age display exists for ([008](./008-message-detail.md)).

## Invariants

Enforces invariant 2 ([nfr/006](./nfr/006-data-fidelity.md)).

## File Structure

| File | Change |
|------|--------|
| `src/replay/produce.ts` | Raw produce |
| `src/views/ConfirmWrite.tsx` | Shared confirm dialog ([019](./019-write-safety.md)) |
