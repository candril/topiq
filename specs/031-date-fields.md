# Date Fields as Dates

**Status**: In Progress — P1 built for `timestamp-millis` and `date`. P2 and P3 not started.

## Description

An Avro `timestamp-millis` field arrives as an int64 and, because the schema walk drops the
logical annotation to keep every long a BigInt ([005](./005-schema-registry.md)), reaches the
table as `1789980152905`. That is the correct number and a useless cell: the reader has to
paste it into a converter to learn that the order was placed four minutes ago, while the
envelope's own timestamp column two cells to the left reads as a date.

This turns the declared logical type back into a `Date` at decode, so a date field reads,
sorts and filters as a date everywhere the envelope timestamp already does.

## Capabilities

### P1 — Must Have

- **`timestamp-millis` and `date` decode to `Date`.** Applied by walking the schema next to
  the value, so a field nested in a record, an array, a map or a union is converted too.
- The table renders them like the envelope timestamp; the `$EDITOR` **view** shows ISO-8601.
- Sorting a date column orders chronologically ([024](./024-table-column-navigation.md)).
- The filter grammar's date handling applies to them: `value.placedAt>2026-09-01` works,
  because the compiled predicate already types a `Date` actual as a date
  ([010](./010-filter-bar.md)). `*` on the cell produces a term that matches.
- **The write paths are unaffected.** Every re-encode already passes through
  `coerceToType` ([014](./014-edit-and-replay.md), [015](./015-craft-message.md),
  [016](./016-cross-cluster-copy.md)), which turns a `Date` back into the BigInt millis the
  schema expects — so a cross-cluster copy of a message with a timestamp still encodes.
- **The editable `$EDITOR` buffer keeps bare millis**, not ISO. See Decisions.

### P2 — Should Have

- `time-millis` and the `-micros` family rendered in their own right (see Decisions for why
  they are deliberately untouched here).
- A crafted message ([015](./015-craft-message.md)) seeded with the current instant for a
  timestamp field instead of `0`.

### P3 — Nice to Have

- A relative form in the table (`4m ago`) behind a toggle, as the topic list ages are.

## Out of Scope

- Guessing. A field is a date because its schema says so, never because it is a long in a
  plausible range or because it is named `…At` — a Unix-seconds field read as millis is off
  by a factor of a thousand and looks plausible either way.
- Changing what is produced. This is a decode-side reading of a declared type; the bytes on
  the wire are untouched, and byte-exact replay never decodes at all
  ([013](./013-byte-exact-replay.md)).

## Technical Notes

- The conversion cannot live in avsc. Registering a logical type there would build the
  underlying long through avsc's own `LongType` — the object-form trap `normalizeSchema`
  exists to avoid — so the value would already have been through `Number` before the logical
  wrapper saw it ([nfr/006](./nfr/006-data-fidelity.md) invariant 1). It is therefore a
  post-decode walk over the *raw* schema JSON, which still has the annotations.
- Named type references are resolved against the definitions collected during the walk, with
  a seen-set, so a self-referential schema terminates.
- The path is cached per registry instance beside the avsc type, keyed by schema id.

## Decisions

- **Only `timestamp-millis` and `date`.** Both map onto `Date` exactly: millis since the
  epoch, and days since the epoch at UTC midnight. The others do not, and a wrong reading is
  worse than digits:
  - `timestamp-micros` would lose its sub-millisecond digits in a `Date`, which is precision
    loss on a read path that exists to prevent precision loss.
  - `time-millis` is a time of day, not an instant; a `Date` would invent 1970-01-01.
  - `local-timestamp-millis` has no zone, so rendering it as UTC states something the
    producer did not.
- **The editable buffer stays in millis.** `stringifyEditable` already diverges from the
  reading form for bytes, for the same reason: it has to survive being parsed back. Writing
  ISO there would mean `coerceLong` had to turn date-shaped strings into longs, and it
  cannot know whether the field it is looking at is millis or micros — a silent factor of a
  thousand. Digits round-trip unambiguously.
- **`coerceLong` accepts a `Date`.** That is the seam that keeps every write path working
  without knowing anything about logical types: the value carries its own identity, so a
  copy, an edit and a craft all converge on the same BigInt.

## File Structure

| File | Change |
|------|--------|
| `src/schema/logical.ts` | The schema walk: which fields are dates, and the conversion |
| `src/schema/avroType.ts` | Cache the raw schema beside the type, keyed by id |
| `src/schema/decode.ts` | Apply the conversion after `fromBuffer` |
| `src/schema/coerce.ts` | `Date` → BigInt millis, so every re-encode keeps working |
| `src/render/json.ts` | The editable leaf writes a `Date` as bare millis |
| `src/table/sort.ts` | Compare `Date`s chronologically |
