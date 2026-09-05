# Table Column Navigation

**Status**: In Progress — P1 built (column cursor, `h`/`l`/`0`/`$`, type-aware sort on
`s`, header marker); P2 (hide, display modes, filter-by-cell) and P3 not started. Verified
by unit tests only — no render-level harness exists yet, so the header marker has not been
seen on a real screen.

## Description

The message table ([007](./007-message-table.md)) is a grid, but only its rows are
navigable: there is a row cursor and no column cursor. This spec adds the second axis —
monq's model, which lane shares for its board — so the column under the cursor becomes a
target for sorting, hiding, resizing and filter-by-value.

Without a column cursor there is nowhere to hang those actions, which is why
[007](./007-message-table.md) P2 ("hide/show columns", "sort by a column") has stayed
unbuilt: the spec named the actions but not the selection they act on.

## Capabilities

### P1 — Must Have

- A **column cursor** alongside the row cursor, clamped to the visible column set and
  re-clamped when inference changes the columns ([007](./007-message-table.md)).
- The cursor covers the **envelope columns too** (partition, offset, timestamp), not only
  the inferred value columns — otherwise the most obvious sort key on a Kafka topic,
  timestamp, is unreachable. They are named as the filter grammar names them, so sorting
  by `timestamp` and filtering on `timestamp:` mean the same field.
- `h`/`l` (and `←`/`→`) move it; `0`/`$` jump to first/last column — monq's bindings.
- The selected column is visibly marked in the header row, not only by the cell highlight,
  so the target of the next action is unambiguous.
- `s` cycles **sort** on the selected column: ascending → descending → unsorted, where
  "unsorted" is the window's own order — timestamp descending
  ([007](./007-message-table.md)), not arrival order. Sorting
  is client-side over the loaded window (Kafka has no server-side sort) and **must compare
  by decoded type** — BigInt columns compare as BigInt, never through `Number`
  ([nfr/006](./nfr/006-data-fidelity.md)).
- Sort state is visible in the header (`▲`/`▼` on the sorted column) and survives a filter
  change; a window reload resets it with the window.

### P2 — Should Have

- **Built:** `-` hides the column under the cursor (envelope columns excepted — a row with
  no partition/offset/timestamp has no identity), and `c` opens a **field picker** listing
  every path the loaded window contains, not just the ones that fit: `space` toggles,
  `a` shows everything again, `esc`/`enter` closes. Toggles apply as you make them, so
  there is nothing to commit. The chosen set survives a range change — it describes the
  topic, not one window — and hiding resets the column cursor, which indexes the *visible*
  set and would otherwise silently point at a different column.
- `w` cycles the column's **display mode**: normal → full → minimised (monq's
  `CYCLE_COLUMN_MODE`), so one wide payload field can be opened without re-fitting
  everything.
- **Built:** `*` filters by the selected cell's value — vim's "search what is under the
  cursor" (`f` is follow mode, [012](./012-live-tail.md)). It *writes the term into the
  filter bar* ([010](./010-filter-bar.md)) rather than applying a hidden predicate, so the
  filter stays one editable, visible expression, and appends with the grammar's implicit
  AND so repeated presses narrow. BigInt cells keep every digit, values needing quotes get
  them, and a cell with nothing to filter on (absent, or a whole subtree) says so on the
  status line instead of silently doing nothing.

### P3 — Nice to Have

- Horizontal scrolling when the visible columns exceed the width, following the cursor.
- `y` yanks the selected cell; `⇧Y` the whole row (monq).

## Out of Scope

- Server-side sort. It does not exist in Kafka; sorting only ever reorders the loaded
  window, and the header must not imply otherwise.
- Re-ordering columns by hand. Inference decides order
  ([007](./007-message-table.md)); hiding is enough control.
- Column navigation in the topic list or cluster picker — those are single-column lists,
  see the binding decision below.

## Decisions

- **`h`/`l` mean horizontal movement inside a grid, and hierarchy inside a plain list.**
  The message table is a grid, so there `h`/`l` walk the column cursor (monq's
  `nav.left`/`nav.right`); the topic list and cluster picker have one column, so nothing
  is competing for the keys and they keep the ascend/descend meaning
  [020](./020-keyboard-navigation.md) gave them. Both sibling tools work this way — monq
  moves columns with `h`/`l` in its document table while the sidebar uses them to change
  focus, and lane walks its board grid with them.

  This corrects an earlier, more absolute claim of mine that `h`/`l` should *never* mean
  ascend/descend and should do nothing in single-column views. That would have deleted a
  working binding for a consistency the sibling tools do not actually keep. Ascending from
  the message table stays on `Esc`, which is unambiguous there.

- Sort lives on the column cursor rather than a `sort by…` prompt, matching the topic
  list's existing `s` ([006](./006-topic-list.md)) and monq's `doc.sort`.

## Technical Notes

- Column state (`selectedColumnIndex`, `sortField`, `sortDirection`, hidden set, display
  modes) belongs in the messages sub-reducer, and the sort comparator lives beside the
  inference code in `src/table/` — pure, so the BigInt ordering is directly testable.
- Sorting must be **stable** and applied after filtering, so the row the cursor sits on
  stays put when a filter narrows the set.
- Re-inference on a new window must not silently move the sort to a different field: if
  the sorted field disappears from the column set, drop the sort and say so in the header.

## File Structure

| File | Change |
|------|--------|
| `src/table/sort.ts` | Type-aware comparator + stable sort over the window |
| `src/table/infer.ts` | Column set gains hidden/display-mode state |
| `src/state/messages.ts` | Column cursor, sort, hidden columns |
| `src/views/MessageTable.tsx` | Header marker, `h`/`l`/`0`/`$`/`s`/`-`/`w`/`f` |
