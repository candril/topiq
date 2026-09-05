# Live Tail & Bounded Buffer

**Status**: In Progress — P1 built (follow from the window end, bounded buffer with stated
drops, pause/resume, filter on arrival) plus P2's backpressure and filter-before-buffer
bullets. Two honest gaps against P1: the cap is a **constant, not configurable** (Open
Questions), and while paused the drop count is not repainted until resume, so rows are
dropped without the header saying so until the tail resumes. P2 throughput indicator and
P3 highlighting open. Nothing has been run against a live broker — `just smoke` does not
exercise follow, and there is no render harness for the key bindings.

## Description

Follow a topic as messages arrive, with filtering applied live. Kafka topics are unbounded
and terminals are not, so the buffer is bounded by construction and the oldest rows are
dropped — visibly.

## Capabilities

### P1 — Must Have

- Follow mode from the current window end ([009](./009-paging-and-fetch-modes.md)):
  new messages append and the view auto-scrolls unless the cursor has been moved.
- A hard buffer cap (`TAIL_CAP`, currently the same 10,000-row ceiling as a window). At the cap the oldest message is
  evicted, and the header states that rows were dropped — never a silent truncation.
- Pause/resume without disconnecting; paused means "stop appending", buffered messages
  keep arriving up to the cap.
- The active filter applies as messages arrive ([010](./010-filter-bar.md)).

### P2 — Should Have

- Backpressure: if decode + render can't keep up with the broker, drop from the *tail of
  the fetch*, not by growing memory (monq's pattern). **Done** — the arrival queue is
  capped at `TAIL_QUEUE_CAP` and drops count into the same "dropped" total.
- Throughput indicator (msg/s) so a quiet topic is distinguishable from a stalled consumer.
- Filter applies before buffering, so a narrow filter can follow a busy topic. **Done** —
  a row that cannot match never costs a buffer slot.

### P3 — Nice to Have

- Highlight newly arrived rows briefly.

## Out of Scope

- Persisting the stream — [000](./000-vision.md) Non-Goals.
- Committing offsets while following ([009](./009-paging-and-fetch-modes.md)).

## Technical Notes

- The consumer runs off the input path; arriving messages batch into a single state update
  per frame rather than one per message ([nfr/001](./nfr/001-performance.md)).
- ~~Leaving follow mode must `disconnect()` the consumer~~ **Amended (as built):** leaving
  follow calls the `ConsumeHandle`'s `stop()`, which is what disconnects the ephemeral
  consumer — the seam owns the kafkajs object, the view never sees it. Either way the
  process must not hold a socket open ([001](./001-app-shell.md)).

## Keys

| Key | Action |
|-----|--------|
| `f` | Toggle follow |
| `space` | Pause / resume the tail (follow stays connected) |
| `g` | Rejoin the newest row after scrolling away |

## Decisions

- **The tail resumes from the buffer, not from a fresh watermark lookup.** `tailStarts`
  takes one past the highest offset already on screen per partition, falling back to the
  partition's high only where the window holds nothing. Re-resolving the range at the
  moment `f` is pressed would silently skip whatever was produced between loading the
  window and pressing it.
- **The seam grew `startAt` and `follow`, not a new method or a new `FetchRange` kind.**
  `startAt` overrides what the range resolves to; `follow` keeps the consumer reading past
  the high watermark so `done` settles only at the limit or on `stop()`. A `"follow"` range
  kind would have leaked into `FetchMode`, which is a menu of things the *user* picks.
- **The follow consume passes `limit: Infinity`.** Memory is bounded by the display
  buffer, not by the fetch; a tail that quietly stopped at a limit is indistinguishable
  from a quiet topic.
- **One cap for both**, `TAIL_CAP === WINDOW_CAP`: following must not cost more memory than
  the static window it replaces. The arrival queue shares the number — holding more raw
  messages between frames than the buffer could ever display is pure waste.
- **Backpressure drops the front of the queue, not the arrival.** In a tail the newest rows
  are the point, and the dropped ones would have been evicted at the next flush anyway.
  Either way the count is announced (nfr/004) — eviction and backpressure are the same
  statement to the reader: rows existed that this window will never show.
- **Paused keeps consuming.** The flush is skipped, so nothing decodes and nothing appends;
  arrivals pile into the capped queue and land in one batch on resume. No disconnect, so
  resuming costs no rebalance.
- **The cursor is pinned, not moved.** While following, `follow.pinned` means "the cursor
  is wherever the newest row is" — the reducer computes a relative move from there, so the
  first `j` steps back from the tail rather than from a stale stored index. The window is
  newest-first ([007](./007-message-table.md)), so that row is **0**: moving up at the top
  keeps the pin (that is what following already does), moving down releases it, and `g`
  re-pins.
- **Arrivals land at the front of the buffer**, newest of a batch first, and eviction takes
  from the end. The buffer has the same order as the window it was seeded from — two
  orders would make the seam between window and tail visible as a jump.
- **Leaving follow drops the tail buffer** and returns to the fetched window. `space` is
  the way to freeze the tail without losing it; making `f` freeze too would leave two
  indistinguishable stopped states.
- **`r` leaves follow before it reloads.** A reload rebuilds the window the tail was seeded
  from; keeping the buffer would leave rows on screen that the new window never fetched.
- **The predicate is compiled before any rows are touched.** `useFilterPredicate` is split
  out of `useFilteredMessages` so the tail can filter arrivals as they land. Rows in the
  buffer are re-tested at render — idempotent, and it keeps one honest `matched/total` for
  both sources.

## Open Questions

- The buffer cap is not yet configurable (010's `WINDOW_CAP` constant). It becomes a config
  key when [002](./002-cluster-config.md) grows a UI section.
- The tail is seeded once, when `f` is pressed. Pressing it while the window is still
  loading seeds from a partial window; the remaining history keeps landing in the fetched
  window, which is what reappears when follow is switched off.
- **Paused drops are counted but not shown.** `flush` returns before it drains
  `queueDrops`, so backpressure drops during a pause only reach the header on resume. The
  count is never lost, but for the length of the pause the truncation is silent — which is
  the thing nfr/004 exists to forbid. Fix: surface the queue's drop count independently of
  the flush.
- **`tailStarts` falls back to a stale watermark** for a partition the window holds no rows
  from: `p.high` was read when the window loaded, so anything produced to that partition
  between load and pressing `f` is skipped — the same silent gap the "resume from the
  buffer" decision above exists to avoid, just narrowed to the empty partitions. The seam
  already re-fetches watermarks inside `consume`; the fallback should use those.
- **A filter applied while following discards arrivals permanently and silently.** Rows
  filtered out before buffering are not counted as dropped (they were not wanted), but
  clearing the filter afterwards leaves a hole in the tail with nothing to explain it.

## File Structure

| File | Change |
|------|--------|
| `src/kafka/types.ts` | `ConsumeOptions.startAt` / `.follow` on the seam |
| `src/kafka/client.ts` | Follow semantics: past the watermark, memoised `stop()` |
| `src/table/tailBuffer.ts` | Bounded buffer, arrival queue, resume points, labels |
| `src/views/useFollowTail.ts` | The tail consumer, frame batching, pause |
| `src/views/useFilterPredicate.ts` | Text → predicate, split so arrivals can be filtered |
| `src/state/messages.ts` | `follow: { active, paused, pinned }` and its actions |
