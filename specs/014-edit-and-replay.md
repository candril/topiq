# Edit-and-Replay in `$EDITOR`

**Status**: In Progress — P1 built (`e` on a message row), with one deliberate narrowing: a
value carrying no embedded schema id is **refused before the editor opens**, so plain-JSON and
unframed topics have no edit path at all (see Technical Notes). P2/P3 not started. Verified
through `edit.test.ts` (a real `$EDITOR` spawn against a stub script, no Kafka client); the
`e` binding itself has no render harness.

## Description

Decode a message, hand it to `$EDITOR` as JSON, validate the edit against the registry
schema, encode, produce. The flow the org has no tool for: find message → tweak → re-produce.

## Capabilities

### P1 — Must Have

- Open the decoded value as pretty JSON in `$EDITOR` (monq's tmux/`$EDITOR` plumbing
  transplants directly); an unchanged buffer or empty save aborts.
- BigInts survive the round trip: serialise them unambiguously and parse them back to
  `BigInt`, not `Number` ([nfr/006](./nfr/006-data-fidelity.md)).
- Validate the edited value against the message's schema **before** producing; a schema
  violation is shown with the offending path and nothing is produced.
- Encode against the schema and produce, gated by `allow_write` + confirm dialog
  ([019](./019-write-safety.md)).
- Key and headers are preserved as raw bytes unless explicitly edited.

### P2 — Should Have

- Edit the key and headers too, in the same buffer (a framed document: metadata section +
  key + value), lane's single-buffer editing pattern.
- Produce to a different topic on the same cluster.
- Show a diff of decoded-original vs edited before the confirm.

### P3 — Nice to Have

- Re-edit after a validation failure without losing the buffer.

## Out of Scope

- Byte-exact replay of an *unmodified* message — [013](./013-byte-exact-replay.md), which
  must not go through this path.
- Cross-cluster — [016](./016-cross-cluster-copy.md).

## Technical Notes

- This path **necessarily** re-encodes, so the produced bytes differ from the original even
  for a no-op edit. That is why [013](./013-byte-exact-replay.md) exists separately;
  don't merge the two. The two are kept apart by their inputs: `replayRecord` takes a
  `RawMessage` and cannot see a decoded value; `editedRecord` takes bytes it was handed.
- Encoding uses the schema the message was decoded with (its embedded id), not the
  subject's latest — editing an old message must not silently upgrade it
  ([005](./005-schema-registry.md)). `editAndReplay` never calls `getLatestSchema`, and its
  test registry throws if it is called.
- `e` triggers, `shift+R` confirms. Trigger and confirm are different keys so a held key
  cannot open the dialog and answer it in one go ([019](./019-write-safety.md)).
- **Unknown fields are violations.** avsc encodes a record field by field and ignores keys
  the schema has no field for, so a mistyped field name would produce a message *missing*
  that field — the edit looks applied and is not. `unknownFields` reports them with their
  path alongside the type violations.
- **Refused before the editor opens** (making someone edit and *then* refusing wastes the
  edit): writes disabled or no cluster; a message that failed to decode; a tombstone; and a
  value with no embedded schema id — plain-JSON and unframed values have no schema to
  validate an edit against, and producing an unvalidated re-encode is worse than refusing.
  Extending P1 to plain-JSON topics needs a decision about what "valid" means there.
- **A semantically unchanged save aborts**, not just a byte-identical one: the comparison is
  over the re-rendered value, so comment-only, whitespace-only and key-reordering saves all
  abort. If the same bytes are wanted, [013](./013-byte-exact-replay.md) is the honest path.

## Resolved Questions

- **What JSON encoding for BigInt in the editor buffer?** **Bare numeric literals, read back
  by field type** — the preferred option. `stringifyEditable` writes a BigInt as its digits;
  `parseEditBuffer` promotes only literals too large for a `Number` (jsonFallback); then
  `coerceToType` walks the avsc type and converts every `long` position to `BigInt` and every
  non-`long` back. So an `int` field never becomes a BigInt and a `long` field never stays a
  Number, whatever the literal looked like. Quoting or suffixing would have made the buffer
  non-JSON to every editor and asked the user to keep a convention the schema already knows.
- **How do `bytes` survive the buffer?** As a full-hex JSON string (`"0x1f8b…"`), coerced
  back at `bytes`/`fixed` positions. The reading renderer (`stringifyPretty`) truncates byte
  previews at 16 bytes, which would silently shorten a `bytes` field on save — hence a second
  leaf writer rather than reuse.

## File Structure

| File | Change |
|------|--------|
| `src/editor/view.ts` | `$EDITOR` round trip — `editInEditor` returns the saved buffer, sharing the temp-file mode/lifetime with `viewInEditor` (rather than a separate `launch.ts`) |
| `src/replay/editBuffer.ts` | The editable document and its reader (pure) |
| `src/replay/edit.ts` | Decode → edit → validate → encode → gate |
| `src/schema/coerce.ts` | Type-directed read-back: longs, bytes, unions; unknown-field reporting |
| `src/render/json.ts` | `stringifyEditable` + `hexLiteral` — the parseable, untruncated form |
| `src/views/messageDoc.ts` | `metadataHeader` shared by the read-only and editable documents |
| `src/views/MessageTable.tsx` | `e` opens the flow; the outcome routes to the confirm dialog or the status line |
