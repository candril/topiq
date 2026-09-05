# Topic List

**Status**: Done — P1+P2 built (rows, filter, internal toggle, sort, scrollable partition
pane, lazy watermarks, between-runs listing cache); P3 registry-subject markers not built

## Description

The entry view: every topic on the connected cluster with its partition count, watermarks
and approximate message count, filterable by name. Choosing one opens the message table.

## Capabilities

### P1 — Must Have

- List topics from the admin client, with partition count and total messages
  (Σ `high − low` per partition).
- **The list is paid for in two parts.** Names and partition counts come from one metadata
  round-trip and paint immediately; watermarks cost a request *per topic*, so they are
  fetched only for the rows on screen and fill in as the cursor scrolls. An unmeasured
  count renders `—` — never `~0`, which is a real count ([nfr/006](./nfr/006-data-fidelity.md)).
  Sorting *by* count is the exception: a sort over half-known values would be a lie, so
  that key measures every visible row first, behind the loader ([025](./025-loading-indicators.md)).
- Incremental name filter (type to narrow).
- Enter opens the topic in the message table ([007](./007-message-table.md)).
- Respect `topic_prefix`: a prefixed profile shows only its namespace by default
  ([002](./002-cluster-config.md)).

### P2 — Should Have

- Internal topics (`__consumer_offsets`, `_schemas`) hidden behind a toggle (`i`).
  "Internal" means a `_`-prefixed name — the broker-side convention. The toggle governs
  internal topics even under a `topic_prefix`, which would otherwise hide them forever.
- Per-partition detail: low/high watermark, leader — a `p` toggle pane for the cursor
  topic, fed by one `fetchTopicMetadata` round-trip in `listTopics`. The pane scrolls
  (`J`/`K`) and always names its slice, so a 64-partition topic is fully readable.
- Sort by name / message count / partition count (`s` cycles; counts sort descending).
- **The listing is remembered between runs**, per profile, under
  `$XDG_CACHE_HOME/topiq/topics/`. A returning cluster paints from disk immediately and the
  fresh listing replaces it when it lands — the topic set changes on the timescale of a
  deployment, so the wait was never buying much. The cache is keyed by profile *and* its
  brokers, so a repointed profile never serves another cluster's topics, and entries older
  than a week are dropped rather than shown. Watermarks are never cached: they are exactly
  the part that moves.

### P3 — Nice to Have

- Mark topics that have a registry subject, so schema-less topics are visible at a glance.

## Out of Scope

- Creating/deleting topics or changing partitions — [000](./000-vision.md) Non-Goals.
- Consumer groups per topic — [017](./017-consumer-groups.md). The list only carries the
  way in: `c` opens the group view for the topic under the cursor, since lag is per topic.

## Technical Notes

- `high − low` is an *approximation* of message count: it ignores compaction and retention
  gaps. Label it as approximate rather than implying an exact count (rendered `~1,234`).
- Watermarks are `bigint` ([004](./004-data-model.md)); the subtraction must not go through
  `Number`.
- The incremental filter is entered with `/` (spec [020](./020-keyboard-navigation.md)
  vocabulary); typed characters narrow live, `Enter` keeps the filter, `Esc` clears it.
  While it captures text, `q`/`?` are characters, not commands — the filter flag lives in
  the app reducer so the global keymap can see it.
- Topic fetching stayed on the seam, split in two: `listTopics` returns `TopicSummary[]`
  (name + partition count, one round-trip) and `fetchWatermarks(names)` measures a subset.
  No separate `src/kafka/metadata.ts` was needed — pure list logic lives in
  `src/views/topicListModel.ts` instead.
- The view remembers which names it has *asked* for in a ref, not in state: the request is
  issued during an effect and a re-render must not queue it twice.
- The partition pane borrows its height from the list: it shows up to `PANE_MAX_ROWS`
  (8) partitions, fewer on a short terminal, and never squeezes the topic list below
  three rows.

## Decisions

- **`J`/`K` scroll the pane, `j`/`k` keep moving the topic cursor.** The pane describes
  the topic under the cursor, so the scroll key must not be able to move off that topic.
  Shift is free for it by construction — `levelNav` declines every modifier
  ([020](./020-keyboard-navigation.md)) — and the binding only intercepts `J`/`K` while
  the pane is open, so unshifted movement is untouched.
- **A slice label replaces the old "… N more" line.** The header reads
  `partitions 9–16 of 64`, so the hidden partitions are stated wherever the scroll sits,
  not only at the bottom ([nfr/004](./nfr/004-reliability-and-errors.md)); the pane also carries
  a `J/K scroll` hint, but only when there is something to scroll.
- **No `<scrollbox>`.** The pane windows its own array with an offset in the reducer, the
  same plain-slicing approach the topic list and message table already use — one scrolling
  idiom in the app, and the pure part stays testable without a renderer.
- **The offset rewinds whenever the cursor could land on another topic** (move, jump,
  sort, filter, internal toggle, pane toggle) — a pane opening pre-scrolled into a
  different topic's partitions would be a lie. Render clamps as well, so a resize that
  shrinks the pane cannot strand it past the end.

## File Structure

| File | Change |
|------|--------|
| `src/views/TopicList.tsx` | The view: fetch via the seam, keymap, windowed rows, detail pane, lazy watermark measurement |
| `src/cache/topics.ts` | The between-runs listing cache: read/write, broker + age validation |
| `src/views/topicListModel.ts` | Pure row shaping, visibility (filter/prefix/internal), sort, window, partition-pane sizing + slice label |
| `src/state/topicList.ts` | Reducer slice: filter, internal toggle, sort, cursor, detail pane + its scroll offset |
