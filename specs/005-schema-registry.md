# Schema Registry & Avro Decoding

**Status**: In Progress — P1 built and in use: decode, encode and the per-instance registry
cache. `encodeWithType` is now called by every produce path
([014](./014-edit-and-replay.md), [015](./015-craft-message.md),
[016](./016-cross-cluster-copy.md)); `encodeBySchemaId` / `encodeWithSchema` /
`encodeLatestForSubject` have no caller yet and are covered by tests only. P2's
subject/version in the detail pane is not built.

## Description

Decoding the Confluent wire format (magic byte `0x00` + 4-byte schema id + Avro payload)
for keys and values, against the cluster's registry, with a cache. This is where invariant
1 is enforced or lost.

## Capabilities

### P1 — Must Have

- Fetch a schema by id from the profile's `registry`, authenticating with the profile's
  SASL credentials as basic auth ([002](./002-cluster-config.md)).
- Decode key and value independently — a topic commonly has an Avro `long` key and a
  record value.
- **`avsc` configured to decode `long` as `BigInt`.** Non-negotiable
  ([nfr/006](./nfr/006-data-fidelity.md)); this is the Redpanda bug topiq exists to avoid.
- Schema cache keyed by id, per cluster. Ids are registry-local — never share a cache
  across profiles ([016](./016-cross-cluster-copy.md)).
- Non-Avro payloads degrade gracefully: no magic byte → try UTF-8 JSON → else hex.
  Never throw a view away over an undecodable message.
- Encoding: given a subject's schema, encode a JS value back to the wire format for
  produce ([014](./014-edit-and-replay.md)).

### P2 — Should Have

- Fetch the latest schema for a subject (`<topic>-value` / `<topic>-key`) as a template
  ([015](./015-craft-message.md)) and for validation before produce.
- Surface the schema id and subject/version in the detail pane
  ([008](./008-message-detail.md)).
- Schema-variance tolerance: a topic carrying several subtypes decodes each by its own id,
  no assumption of one schema per topic.

### P3 — Nice to Have

- Show the schema text for the focused message.

## Out of Scope

- Registering, evolving or deleting schemas — [000](./000-vision.md) Non-Goals.
- Protobuf / JSON-Schema registry formats until a real topic needs them.

## Technical Notes

- **Decision (as built):** the `@kafkajs/confluent-schema-registry` wrapper was dropped.
  Its forSchema path hits the object-form primitive trap (Open Questions below), and the
  registry HTTP it does is ~30 lines. `src/schema/` parses the 5-byte header itself and
  calls `avsc` directly with full control of the options: `registry.ts` (fetch-by-id +
  cache, per cluster), `decode.ts` (wire format + primitive normalisation + fallbacks),
  `long.ts` (the BigInt `LongType`). Encoding will use the same modules.
- Decoding happens above the client seam, so raw buffers are always still available for
  replay ([013](./013-byte-exact-replay.md)).
- **One registry instance per cluster profile, and the schema cache is keyed by that
  instance** (`avroType.ts` holds a `WeakMap<SchemaFetcher, Map<number, Type>>`). Schema ids
  are registry-local, so a cache shared across two registries would hand one cluster's bytes
  the other's schema — silently, producing a message that decodes into something else.
  Cross-cluster copy ([016](./016-cross-cluster-copy.md)) refuses one registry object serving
  both sides rather than trusting its caller.
- `getVersionForId(subject, id)` covers the direction the wire format cannot: a payload
  embeds an id, and a copy dialog that says "id 42 → id 88" tells the reader nothing. It
  reads `/schemas/ids/{id}/versions` and picks the entry matching the subject — an id is
  shared by every subject with identical schema text, so the first entry would be an
  arbitrary one.

## Open Questions

- ~~**Does the registry client expose `avsc` options?**~~ **Resolved: yes, with one
  trap.** `{ [SchemaType.AVRO]: { registry: { long: longType } } }` reaches avsc and
  record *fields* decode as BigInt. But a **top-level primitive schema** (the key subject
  is bare `{"type":"long"}`) bypasses the registry option in `avsc.Type.forSchema` — the
  object form creates a fresh default LongType, while the name form (`"long"`) resolves
  through the registry. The decode layer must therefore normalise
  `{"type":"<primitive>"}` schemas to name form (or decode the wire format itself, as
  `spike/consume.ts` does for keys). Without this, keys silently decode as `number` —
  an invariant-1 violation the spike caught ([nfr/006](./nfr/006-data-fidelity.md)).

  **Amended (spec 015):** the normalisation is *recursive*, not top-level only. The form
  that actually occurs in the estate is a nested
  `{"type":"long","logicalType":"timestamp-millis"}`, which hit the same trap: that one
  field decoded through avsc's own LongType (a `Number`, and a throw past 2^53) while every
  other long in the same message was a BigInt. Anything walking types by name —
  `coerce.ts`, `skeleton.ts` — then treated it as a BigInt long and rejected the value.
  Dropping the logical annotation costs nothing: no logical types are registered, so avsc
  already ignores it and keeps the underlying type.

- ~~**Can the BigInt `LongType` refuse to serialise?**~~ **Resolved: no.** `toJSON` threw
  on purpose, to keep a rounded `Number` from escaping through `JSON.stringify`. But avsc
  copies a field's declared default through `fromJSON(toJSON(value))` while *building the
  type*, so any schema with a `{"type":"long","default":…}` field failed to parse at all
  and the whole topic decoded as an error. It now returns the digits as a string: lossless,
  and never a Number. UI rendering still goes through `src/render/json.ts`.

- **Fallback JSON parse is lossy for int64-sized numbers** (gate finding): a
  non-Confluent-framed payload falls back to `JSON.parse`, whose `Number`s round above
  2^53. Outside invariant 1's letter (that binds Avro `long`), inside its spirit —
  a BigInt-aware JSON parse for the fallback path is open.

## File Structure

| File | Change |
|------|--------|
| `src/schema/registry.ts` | Registry client + caches: by id, subject → latest, and (id, subject) → version |
| `src/schema/decode.ts` | Wire format → `DecodedMessage` |
| `src/schema/encode.ts` | Value + schema → wire bytes; validation with a dotted path |
| `src/schema/wire.ts` | Confluent framing shared by decode and encode |
| `src/schema/avroType.ts` | `parseType` + the id → avsc type cache, one builder for both halves |
| `src/schema/coerce.ts` | JSON forms back to schema forms (long → BigInt, hex → bytes) + unknown-field reporting, for spec 014's `$EDITOR` round trip |
| `src/schema/skeleton.ts` | Type → placeholder value + union notes, for spec 015's craft buffer |
