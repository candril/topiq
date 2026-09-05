# Filter Bar

**Status**: In Progress — P1 built; P2 field/value autocomplete built (`^y` accepts).
Remaining: filter history, saved filters, `header.<name>:` terms. Verified by unit tests
only — no render-level harness exists yet.
## Description

The 90% case for filtering: a monq-style one-line grammar over the decoded message —
`key:12345 value.IsOnboarded:true value.UpdateDate>2026-08-01` — with field-name
autocomplete from the sniffed schema. Compiles to the same local predicate the JS escape
hatch produces ([011](./011-js-filter.md)).

## Capabilities

### P1 — Must Have

- Grammar over `{key, value, headers, partition, offset, timestamp}` with dotted paths:
  `field:value` (equality), `field>x` / `field<x` (ordering), bare word = substring match
  anywhere in the decoded value.
- Regex literals: `value.loginAccountId:/pansen/` tests the value's rendered form, so it
  works on strings, BigInts and subtrees alike. Case-insensitive unless flags are given;
  a malformed pattern degrades to a plain literal rather than an error.
- Values are typed by the field's decoded type: a BigInt field compares as BigInt, a date
  field parses ISO-8601 — `key:12345` must match a `12345n` key
  ([nfr/006](./nfr/006-data-fidelity.md)).
- Negation (`-field:value`) and implicit AND between terms.
- Applied to the current window instantly; the row count shows matched/total.
- A malformed expression is an inline error, never a crash and never a silent no-op
  ([nfr/004](./nfr/004-reliability-and-errors.md)).

### P2 — Should Have

- **Built:** completion from what is actually loaded — the envelope roots plus every
  inferred column ([007](./007-message-table.md)) at field position, and distinct values
  sampled from the loaded rows once a term has an operator. Completion is **progressive**,
  one dotted segment at a time (monq): `val` + `^y` gives `value.`, which re-offers only
  what lives under it, and a namespace keeps drilling while a leaf lands on `field:` ready
  for a value.
- **Suggestions are built from the *unfiltered* window**, deliberately. A half-typed field
  name is a valid bare-word term, so filtering live on it empties the table — and if the
  completion source were the filtered rows, the field list would vanish at exactly the
  moment it is needed. `^y` accepts the highlighted
  suggestion into the bar; `Enter` still applies. Suggestions open with the bar and narrow
  as you type (monq's arrangement). While the list is open `^n`/`^p` drive it rather than
  the row cursor.
- Filter applies to the live stream as messages arrive ([012](./012-live-tail.md)).
  **Done** — arrivals are tested before they are buffered, so a row that cannot match never
  costs a buffer slot.
- Filter history for the session.

### P3 — Nice to Have

- Saved filters per topic in config.
- `header.<name>:` terms.

## Out of Scope

- Server-side filtering. Kafka has none; everything here is local over consumed messages.
- Arbitrary expressions — that's the escape hatch ([011](./011-js-filter.md)).

## Technical Notes

- Both tiers compile to one `(msg: DecodedMessage) => boolean`, so the table, the live
  stream and the replay selection all consume a single predicate type.
- Comparison must not coerce BigInt through `Number`; the compiler picks a comparator from
  the operand's decoded type.
- lane's filter grammar is the closest prior art; keep the syntax family recognisable.

## Decisions

- **The bar is OpenTUI's `<input>`, not hand-rolled key handling** — likewise the range
  prompt, and the JS box is a `<textarea>` ([011](./011-js-filter.md)). Per-character
  handling silently lacks the whole readline set people expect: `^w` delete word, `^u`,
  `^a`/`^e`, word motions, undo. The widgets bring it for free, so the keymap here only
  handles what the widget has no opinion about (`^y`, `Esc`, suggestion navigation).

- **The bar sits at the bottom of the view**, below the content, matching presto, lane and
  monq. An idle bar renders nothing at all ([022](./022-help-panel.md)): it shows the
  filter's state, never a hint row.

- **An unknown field root is an error, not a substring search.** `custmer:1` is a typo far
  more often than a wish to search for the text `custmer:1`; the error names the six roots
  and says to quote the term to search for it literally.
- **A bare word searches the rendered value only**, not the key, headers or the envelope
  scalars — a substring hunt across an offset is noise.
- **The bar applies as it is typed**; `enter` only closes it, `esc` clears it. Same
  contract as the topic filter (006), so one muscle memory covers both.
- **The whole filter is one string in the reducer**, `=` prefix and all (see 011), so no
  mode flag can drift out of sync with the text it applies to and session history (P2) is
  a list of strings.
- **A malformed expression keeps the previous result set.** Both compilers answer an error
  with match-all; applying that would flash the whole window back on every keystroke on
  the way to `key:12345`. `effectivePredicate` holds the last predicate that compiled
  (nfr/004).
- **Column inference runs over the matched rows**, so the columns describe what is on
  screen rather than what was fetched.
- **The filter survives a range change and dies with the topic.** It is a question about
  the data, not about the window — but field paths are schema-local, so carrying one to
  the next topic would silently show an empty window.
- **Esc in the table clears the filter before it ascends** (006's pattern): the view
  claims esc while `filter.query !== ""`, and App checks the same condition before
  leaving the topic, so exactly one meaning fires.

## File Structure

| File | Change |
|------|--------|
| `src/filter/parse.ts` | Grammar → AST |
| `src/filter/compile.ts` | AST → predicate |
| `src/views/FilterBar.tsx` | The bar: input, mode tag, inline error |
| `src/views/filterBarModel.ts` | Tier routing, last-good predicate, count label |
| `src/views/useFilterPredicate.ts` | Compile + hold the last-good predicate (split out so the tail can filter arrivals, 012) |
| `src/views/useFilteredMessages.ts` | Apply the predicate over the rows on screen |
| `src/state/messages.ts` | `filter: { query, active }` and its actions |
