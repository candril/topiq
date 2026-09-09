# Scan Mode

**Status**: In Progress — P1 built (`shift+S` runs the filter over the whole range, hits
capped and stated, progress and stop in the header, backpressure on the seam). P2's
throughput readout is built; P3 not started. Verified by unit tests over the pure helpers,
the reducer and the palette, and by driving `--demo` through tmux (start, end state, esc,
re-run, the no-filter refusal). The hook has no render harness, and neither backpressure
nor the stop and cap paths have been exercised against a live broker — the demo's log is
too small to reach any of them.

## Description

A window holds at most 10,000 rows ([009](./009-paging-and-fetch-modes.md)), and the
filter bar narrows *that* ([010](./010-filter-bar.md)). "Find the message with this key
somewhere in the last four million" is therefore unanswerable: the rows the filter would
match never reach memory. Scan mode turns the relationship around — it streams the whole
range through the predicate and keeps only the hits. Memory is bounded by matches, not by
messages read, so the range can be the entire topic.

The motivating comparison is a plain consumer dump piped through `grep`: no cap, but no
progress, no stop, and every line decoded to JSON on the way. A scan is the same read with
those three things.

## Capabilities

### P1 — Must Have

- `shift+S` starts a scan over the active range with the active filter. Hits accumulate in
  the table in scan order — oldest first per partition, the order the broker delivers them
  — and the local filter and sort still apply on top of them.
- A scan **requires a filter**. Without one it is a bigger window, which the cap would end
  at the same 10,000 rows; the key says so rather than reading a topic for nothing.
- **Latest-N becomes the beginning.** The default window is "latest 50", and a scan of the
  latest 50 is the window it replaces. Every other range — beginning, offset, timestamp —
  scans as it stands, so `t` then `shift+S` is "everything since".
- The header shows progress while it runs — messages scanned against the planned total
  from the watermarks, and the hit count — and one of four end states afterwards: **end**
  (the range is exhausted), **stopped** (`shift+S` again), **capped** (10,000 hits: the
  filter is too broad, and the reader is told they have the *first* 10,000, not a sample),
  or **failed** with the error ([nfr/004](./nfr/004-reliability-and-errors.md)).
- `shift+S` while a scan runs stops it and keeps the hits; on a finished scan it runs again
  with the current filter. `esc` leaves scan mode and returns to the window.
- **Backpressure, never drops.** A tail may drop rows and say so ([012](./012-live-tail.md));
  a scan that skipped a message would be a wrong answer. When decode falls behind the
  fetch, the consumer waits — the seam's `onMessage` may return a promise, and the kafkajs
  client awaits it (heartbeating meanwhile, so the ephemeral group is not evicted and
  re-seated at the wrong offset).
- Scan and follow exclude each other: starting one ends the other. A new range or a
  reload ends a scan, as it ends a tail.

### P2 — Should Have

- Throughput (msg/s) beside the progress, so a slow registry is distinguishable from a
  stalled consumer. **Built.**
- Partition scoping, once [009](./009-paging-and-fetch-modes.md) P2 has it.

### P3 — Nice to Have

- A raw-bytes pre-filter that skips the Avro decode for rows that cannot match. See Open
  Questions — it is only sound for a subset of terms.
- An "until" bound (timestamp or offset) so a scan can stop early without a watermark.

## Out of Scope

- Server-side search. Kafka has none; a scan is a local read of every message in the range,
  and the header is honest about how many that is.
- Persisting or exporting hits — [000](./000-vision.md) Non-Goals.
- Scanning more than one topic at once.

## Technical Notes

- **The scan is a third consumer hook**, `useScanRange`, beside the window and the tail. It
  runs `consume` over the scan range with `limit: Infinity` and no `follow`, so `done`
  settles when every partition reaches the high watermark the seam read at start. Arrivals
  queue and flush once per frame like the other two (nfr/001); each flush decodes a batch,
  tests it with the predicate captured when the scan started, and appends the matches.
- **Hits are capped at `SCAN_CAP === WINDOW_CAP`.** At the cap the hook stops the consumer
  itself and reports `capped`. Nothing is evicted: unlike a tail, the first hits are the
  ones a scan promised.
- **Backpressure is the queue's length.** Past `SCAN_QUEUE_CAP` raw messages waiting for a
  flush, `onMessage` returns a promise that the next drain resolves. The kafkajs client
  awaits it inside `eachBatch` and calls the batch's `heartbeat()` after every wait. The demo
  client ignores the promise: its log is already in memory, so there is nothing to bound.
- **Planned count** comes from `resolveOffsets` + `describeTopic` at start, through
  `plannedCount` ([009](./009-paging-and-fetch-modes.md)). It is a watermark snapshot, so
  the header says ≈; a topic being produced to will scan slightly past it.
- **The predicate is fixed for the scan's lifetime.** The reducer records the query the scan
  started with; changing the bar afterwards narrows the hits on screen but cannot recover
  rows already discarded. The header names the scan's own query so a bar that differs from
  it is visibly a second filter.
- **The reducer holds `scan: { range, query, run, stopped } | null`.** `run` is a counter
  so re-running the same query restarts the effect; `stopped` is a flag rather than a
  cleanup so the hits survive the stop.
- Throughput is delivered messages over the last second, read at each flush.

## Keys

| Key | Action |
|-----|--------|
| `shift+S` | Scan the range with the filter · again to stop · again to re-run |
| `esc` | Leave the scan and return to the window (before it clears the filter) |

## Open Questions

- **Raw-bytes pre-filter.** A bare-word term could be tested against the raw value before
  decoding, skipping the registry and Avro work for most rows. It is only sound where the
  rendered form and the bytes agree — UTF-8 strings inside an Avro record, JSON payloads —
  and wrong for numbers (`12345` in a `long` is varint bytes, not digits), enums (an index
  on the wire) and anything compressed by the producer that kafkajs has not already
  inflated. It needs the parsed term, not the compiled predicate, and a per-term soundness
  rule. Not built until measured: at 10k rows decode is ~4ms, so the win is only real on
  multi-million-row scans.
- **Hit order.** Hits are appended in scan order, so the cursor does not move as they land
  and the list reads as the scan found it — the opposite of the window's newest-first
  ([007](./007-message-table.md)). `s` on the timestamp column gives the other order. If
  this reads as inconsistent in use, the alternative is newest-first with the tail's pinned
  cursor.

## File Structure

| File | Change |
|------|--------|
| `src/kafka/types.ts` | `onMessage` may return a promise — the backpressure contract |
| `src/kafka/client.ts` | Await it per message inside `eachBatch`, heartbeat after a wait |
| `src/table/scan.ts` | `scanRange`, caps, progress/end-state labels |
| `src/views/useScanRange.ts` | The scan consumer: queue, backpressure, decode, cap, progress |
| `src/state/messages.ts` | `scan` state and its actions; scan/follow/range exclusions |
| `src/views/MessageTable.tsx` | `shift+S`, esc ordering, header line |
| `src/commands/*` | `fetch.scan` / `fetch.scanClose` in the palette |
