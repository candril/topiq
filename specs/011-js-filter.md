# JS Filter Escape Hatch

**Status**: In Progress — P1 built, plus the multi-line editor box (`=`, `^s` applies).
Remaining: `$EDITOR` hand-off (P2), predicate history, timeout guard (P3) — a runaway
predicate still wedges the UI.
## Description

When the filter bar isn't enough, write the predicate: `(msg) => …` over
`{key, value, headers, partition, offset, timestamp}`. It runs locally, in-process, on the
user's own credentials — so unlike a server-side console filter, it needs no sandbox.

## Capabilities

### P1 — Must Have

- Accept a JS arrow-function body, compile with `new Function`, and apply as the window
  predicate — the same predicate type the filter bar produces
  ([010](./010-filter-bar.md)).
- `msg.value` is the **decoded** value with BigInts intact, so `msg.value.CustomerId >
  100000000000n` works ([nfr/006](./nfr/006-data-fidelity.md)).
- A bare body also gets Redpanda Console's names bound directly — `key`, `value`,
  `headers`, `partitionID`, `partition`, `offset`, `timestamp` — because that is the
  dialect users arrive with. A full arrow or function the user writes themselves is passed
  through untouched. `headers` is bound only when the source mentions it, so the message
  view's lazy header decoding survives for predicates that never look.
- A compile error or a predicate that throws is reported inline with the message; the
  offending message is skipped, not the whole view
  ([nfr/004](./nfr/004-reliability-and-errors.md)).
- Editing the predicate re-evaluates the loaded window without re-fetching.

### P2 — Should Have

- **Built instead:** an in-app multi-line box (`=` opens it, `Enter` inserts a newline,
  `^s` applies, `Esc` cancels), the shape people know from Redpanda Console. It compiles
  on every keystroke so the syntax error is visible while typing, and it seeds from the
  active JS filter so reopening edits rather than restarts. `$EDITOR` hand-off remains
  open for predicates long enough to want a real editor.
- Predicate history for the session.

### P3 — Nice to Have

- A timeout guard so an accidental infinite loop doesn't wedge the UI.

## Out of Scope

- A sandbox. The code is the user's own, running against their own cluster with their own
  credentials — there is no privilege boundary to defend. Say this in the docs so nobody
  "fixes" it later.
- Mutating messages. The predicate is read-only by contract; mutation belongs in
  [014](./014-edit-and-replay.md).

## Technical Notes

- Reused for [016](./016-cross-cluster-copy.md) selection: "copy everything matching this
  predicate" is the same function.
- `new Function` compiles once per predicate edit, not per message.

## Decisions

- **A leading `=` is the mode toggle**, not a keystroke: `=msg.value.CustomerId > 1n`. A
  prefix keeps the whole filter one string in the reducer ([010](./010-filter-bar.md)), so
  nothing can desync a mode flag from the text it applies to, and the mode is visible in
  the bar rather than remembered. `=` is free in the grammar — it is not an operator
  there, and no one searches for a substring beginning with it. A key toggle was rejected
  because the obvious one (`ctrl-j`) is `LF` on many terminals ([nfr/002](./nfr/002-terminal-compatibility.md)).
- **`=` alone is a mode, not a filter.** An empty source matches everything, so switching
  tiers never blanks the window while the predicate is still being typed.
- **`FilterMessage` adds fields to `DecodedMessage` rather than renaming them**: `key` and
  `value` are the *decoded* values (that is what a predicate wants to reach for), and the
  bytes stay addressable as `rawKey`/`rawValue`/`rawHeaders` (nfr/006).
- **Runtime errors are pulled, not pushed.** The bar reads `lastError()` at render;
  `onError` exists for other callers. A predicate throwing on every row of a 10k window
  must not dispatch 10k state updates. The label pins the throw to the row that first
  produced it plus a repeat tally.
- **P3's timeout guard is deliberately not built.** A wall-clock check between messages
  cannot interrupt a `while (true)` inside one call, so it would read as protection
  without being any; an honest guard needs a Worker or a VM with an interrupt.

## File Structure

| File | Change |
|------|--------|
| `src/filter/js.ts` | Compile + per-message error capture |
| `src/views/filterBarModel.ts` | `=` prefix routing between the two tiers |
| `src/views/FilterBar.tsx` | `js` tag + inline compile/runtime error |
