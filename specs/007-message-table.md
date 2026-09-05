# Message Table

**Status**: In Progress — P1 built (inferred columns, lossless cells, tombstone rows,
cursor + scroll, window header); P2/P3 pending, Enter shows a placeholder until
[008](./008-message-detail.md) lands

## Description

The main view: consumed messages as rows, with columns inferred from decoded values —
monq's smart-column behaviour transplanted. The table is what makes a topic legible
without opening every message.

## Capabilities

### P1 — Must Have

- Rows: one per message, with fixed metadata columns (partition, offset, timestamp) plus
  inferred value columns.
- Column inference samples **widely** across the loaded window before deciding — one
  message misleads on a topic with mixed event subtypes
  ([005](./005-schema-registry.md)).
- Every rendered value goes through the lossless renderer: BigInts print in full, empty
  arrays print as `[]` not `NULL`, `null` and *absent* are visually distinct
  ([nfr/006](./nfr/006-data-fidelity.md)).
- Tombstones render as an explicit tombstone row, not an empty one.
- Vertical scroll with a cursor; Enter opens the message in `$EDITOR`
  ([008](./008-message-detail.md)).

### P2 — Should Have

- Hide/show columns, sort by a column, horizontal scroll — all of these need a **column
  cursor** to act on, so they live in [024](./024-table-column-navigation.md).
- Column set is per topic and remembered for the session.
- Row count and the loaded offset range shown in the header, so "what am I looking at" is
  never a guess.

### P3 — Nice to Have

- Key column derived from the decoded key when it is a record rather than a scalar.
- Colour by event subtype.

## Out of Scope

- Fetching/paging semantics — [009](./009-paging-and-fetch-modes.md).
- Filtering — [010](./010-filter-bar.md), [011](./011-js-filter.md).

## Technical Notes

- Inference runs over the current window and is *stable*: adding rows must not reshuffle
  existing columns mid-scroll. Recompute on window change, not per message. Built as:
  columns ranked by presence count across the whole window with first-seen order as the
  tiebreak, memoised on the window array — recomputed per batched flush while loading,
  fixed once the window is done.
- The row cap is a hard limit, not advice — the buffer above it is bounded
  ([012](./012-live-tail.md)). The cap doubles as the consume `limit`, so the broker
  stops sending instead of the UI dropping decoded rows; the header shows
  `capped at N` when the resolved range exceeds it.
- Columns that do not fit the terminal width are dropped rarest-first (`fitColumns`)
  until P2's horizontal scroll exists — rows are never silently truncated mid-cell.
- Rows sort by timestamp (partition/offset tiebreak): partitions have no global order,
  and interleaving by arrival would shuffle on every reload.
- Messages that fail to decode render an explicit `decode failed` row (nfr/004); they
  and tombstones are excluded from column sampling.

## File Structure

| File | Change |
|------|--------|
| `src/views/MessageTable.tsx` | The view |
| `src/views/useMessageWindow.ts` | Window consume + per-frame batched decode (nfr/001) |
| `src/table/infer.ts` | Column inference over decoded values |
| `src/table/window.ts` | Window ordering, latest-N trim, header summaries |
| `src/render/json.ts` | BigInt-safe value rendering |
