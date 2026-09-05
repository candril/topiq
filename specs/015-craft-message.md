# Craft Message from Schema

**Status**: In Progress — P1 built (`shift+N` → skeleton in `$EDITOR` → validate → encode →
`shift+P`). P2 (seed from the focused message, remember the last body per topic) and P3 not
started. Verified through `craft.test.ts` (a real `$EDITOR` spawn, no Kafka client); the
`shift+N` binding itself has no render harness.

## Description

Produce a message that doesn't exist yet: start from the topic's latest schema as a
template, fill it in `$EDITOR`, encode and produce. The "I need a test event on this
topic" case, without hand-writing Avro.

## Capabilities

### P1 — Must Have

- Fetch the subject's latest schema (`<topic>-value`, and `-key` when present) and
  generate a skeleton with each field at a type-appropriate placeholder
  ([005](./005-schema-registry.md)). — **built**
- Edit → validate → encode → produce through the same path as
  [014](./014-edit-and-replay.md), under the same `allow_write` gate
  ([019](./019-write-safety.md)). — **built**
- Optional fields and unions are represented so it's obvious what may be omitted. —
  **built**, as a header block: JSON has no comments past the top of the file, so every
  union position is listed there with its branches (`Note: null | string`).

### P2 — Should Have

- Seed the template from the focused message instead of the bare schema — usually faster
  than filling a skeleton. **Not built.**
- Remember the last crafted body per topic for the session. **Not built.**

### P3 — Nice to Have

- Produce N copies with a varying key.

## Out of Scope

- Registering a new schema — [000](./000-vision.md) Non-Goals. Crafting works only against
  a schema the registry already has. An unregistered `<topic>-value` is refused by name.

## Behaviour (P1, as built)

`shift+N` on the message table opens the skeleton in `$EDITOR`. The buffer is an
**envelope**, not a bare value:

```jsonc
// topiq — craft a new message for dg-orders
// value     dg-orders-value v7 (id 1234)
// key       dg-orders-key v2 (id 12)
//
// value fields that accept more than one type (null means the field may be omitted):
//   Note: null | string
// …rules…
{
  "key": 0,
  "value": { "CustomerId": 0, "Note": "", "Blob": "0x" },
  "headers": {}
}
```

On save: parse → coerce by schema type → validate → encode → the shared confirm dialog
(`shift+P`). The dialog names the cluster, env, topic and the **schema version** the
payload was encoded against, so "latest" is never taken on trust.

Refusals before the editor opens: writes disabled, no cluster, or `<topic>-value` not
registered. Violations after the save are reported with the path they occupy in the
buffer (`value.CustomerId`, `key`, `headers.n`) and nothing is produced.

## Technical Notes

- Uses the subject's **latest** schema (unlike [014](./014-edit-and-replay.md), which uses
  the message's embedded id) — a new message should be current by definition.
- BigInt placeholders must be BigInt-typed from the start, or the first save silently
  produces a `Number` ([nfr/006](./nfr/006-data-fidelity.md)). The skeleton is therefore a
  *decoded* value (BigInt for `long`, `Buffer` for `bytes`), built by walking the avsc
  type, and it validates against its own type before it is ever rendered.

## Resolved Questions

- **The buffer is an envelope, not a value.** A crafted message has no original key to
  re-produce the way [014](./014-edit-and-replay.md) does, and a null key on a keyed topic
  partitions at random and breaks compaction — silently. So `key`, `value` and `headers`
  are all editable in one JSON document, and the header block says how each becomes bytes.
- **A topic with no `-key` subject takes a plain key**: a JSON string, produced as UTF-8,
  or `null` for no key. Anything else is refused — with no schema there is nothing to say
  what the bytes should have been.
- **Header values are strings**, produced as UTF-8 bytes. A non-string is a violation with
  its path, not a coercion.
- **An untouched skeleton is produced, not aborted** — the opposite of 014, where an
  unchanged buffer aborts because the byte-exact path is the honest one. Here the skeleton
  is a valid message and "produce a default event on this topic" is a real intent; the
  confirm dialog is what stands between a stray `:wq` and a write.
- **Unions take their first non-null branch**, so the payload shape is spelled out rather
  than hidden behind a registry lookup; the header block names every branch, so setting a
  field back to `null` is a decision rather than a discovery. A declared field default
  always wins over an invented placeholder.
- **Arrays and maps carry one sample entry**, so the item shape is visible. The header
  says it can be deleted. A recursive record stops there: the array comes out empty and a
  recursive union takes its `null` branch.
- **`shift+N`, and the dialog commits on `shift+P`** — trigger and confirm stay different
  keys ([019](./019-write-safety.md)), and the trigger is not adjacent to `p`, which
  promises byte-exactness.

## Open Questions

- Should the last crafted body be remembered per topic (P2)? Today every craft starts from
  the skeleton, so a second event on the same topic is retyped.
- Should `headers` accept a hex string (`"0x…"`) for a binary header value? Today it is
  UTF-8 strings only, which covers `traceparent` and every header seen in the estate.

## File Structure

| File | Change |
|------|--------|
| `src/schema/skeleton.ts` | Avro type → skeleton value + union notes (pure) |
| `src/replay/craftBuffer.ts` | Envelope → `$EDITOR` buffer, and its reader |
| `src/replay/craft.ts` | The flow: latest schema → editor → validate → encode → gate |
| `src/replay/outcome.ts` | The outcome union shared with [014](./014-edit-and-replay.md) |
| `src/views/produceFlows.ts` | The table's write handlers, out of `MessageTable.tsx` |
