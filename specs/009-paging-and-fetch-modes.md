# Paging & Fetch Modes

**Status**: In Progress — P1 done: range descriptors, watermark math, broker timestamp
resolution, and the UI (mode prompts `o`/`t`/`n`/`b`, resolved range + mode in the header,
window end stops). P2 (follow, paging, partition scoping) pending

## Description

How a window of messages is chosen: from an offset, from a timestamp, the latest N, or
following the tail. Kafka can only read forward, so "latest N" is watermark arithmetic,
not a backwards read — this spec is where that asymmetry is handled once.

## Capabilities

### P1 — Must Have

- **From offset**: start at a given offset on every partition (or one partition).
- **From timestamp**: resolve timestamp → offset per partition via the client's offset
  lookup, then read forward.
- **Latest N**: per partition, start at `high − ceil(N / partitions)`, clamped to `low`.
  Over-fetch and trim, since partitions are unevenly filled.
- A window has an explicit size; reaching the end stops rather than blocking. `n` sets
  that size — it is the page size — up to a **10,000-row cap**, matching what Redpanda
  Console offers. The default window stays small (50) so the first screen is fast; the cap
  is only the ceiling. Measured at 10k rows the local work is negligible (flatten 11ms,
  inference 4ms, filter 2ms, sort 2ms, ~24MB); the real cost at that size is the fetch.
- The active mode and resolved per-partition range are visible in the header
  ([007](./007-message-table.md)).

### P2 — Should Have

- **Follow/tail**: continue consuming from the window end — [012](./012-live-tail.md).
  **Done** there: `f` follows from the end of the loaded window, the seam grew
  `ConsumeOptions.startAt` / `.follow` for it.
- Page forward/back through consecutive windows (back = re-read from a recomputed start
  offset; there is no rewind).
- Partition scoping: read one partition instead of all.

### P3 — Nice to Have

- Remember the last mode per topic for the session ([002](./002-cluster-config.md) P3).

## Out of Scope

- Committing offsets. topiq reads with no consumer group of its own; a group's offsets are
  only touched deliberately in [018](./018-consumer-group-offset-seek.md).

## Technical Notes

- Watermark math lives **above** the client seam ([003](./003-kafka-client-seam.md)) so
  both candidate clients behave identically, and all of it is `bigint`
  ([nfr/006](./nfr/006-data-fidelity.md)).
- ~~Reading with an assigned partition set avoids joining a consumer group.~~
  **Amended (as built):** kafkajs has no assign-only read, so the seam joins an ephemeral
  `topiq-read-*` group with `autoCommit: false` — no offset is ever *committed*, which is
  the property that matters. [017](./017-consumer-groups.md)'s group list should filter
  these ephemeral groups out.
- Timestamp lookup returns `null` when a partition has nothing at or after the timestamp;
  that partition contributes no rows rather than falling back to `low`.

## File Structure

| File | Change |
|------|--------|
| `src/kafka/range.ts` | Range descriptors + watermark math |
| `src/state/messages.ts` | Mode/range state + prompt (named for the slice, not `reducers/fetch.ts` — state lives flat under `src/state/`) |
| `src/table/window.ts` | Range-input parsing + header summaries |
