# Cross-Cluster Copy

**Status**: In Progress — P1 complete (`y` → destination bar → prefix-mapped topic →
two-registry re-encode → gated `shift+C`, and a **production destination is refused until
its cluster name is retyped**). P2 (batch copy, dry run) and P3 not started.
## Description

Copy messages from one cluster to another (prod → test being the motivating case). The
schema id embedded in a payload refers to the *source* registry, so this can never be a
byte copy: the value must be decoded and re-encoded against the destination registry. The
UI's job is to make that distinction explicit rather than silent.

## Capabilities

### P1 — Must Have

- Choose a destination cluster profile ([002](./002-cluster-config.md)) and topic;
  destination `allow_write` must be true ([019](./019-write-safety.md)).
- Decode against the source registry, resolve the equivalent subject on the destination
  registry, re-encode, produce.
- **The confirm dialog states that bytes will differ and why**, naming both clusters and
  both schema ids/versions. Never present this as a copy
  ([nfr/006](./nfr/006-data-fidelity.md), invariant 3).
- Abort with a clear message when the destination registry has no compatible schema for
  the subject — do not fall back to producing raw bytes.
- **Built:** refuse a production destination unless it is the explicit target — the
  confirm dialog demands the destination cluster's name be **retyped** before `shift+C`
  does anything ([019](./019-write-safety.md)). Ordering prod last in the picker and
  colouring the dialog are hints, not refusals; typing the name is what makes a target
  explicit. Prod-ness is the declared `env` ([023](./023-cluster-groups-and-environments.md)),
  never a hostname — a host with `prod` in its name declared `test` is not prod.

### P2 — Should Have

- Copy a selection, or everything matching the active filter
  ([010](./010-filter-bar.md), [011](./011-js-filter.md)), with per-message result
  reporting.
- ~~Topic-name mapping honouring `topic_prefix`~~ **built in P1** (prod `foo` → test
  `test-foo`), and the destination defaulting to the sibling `group`/`env`
  ([023](./023-cluster-groups-and-environments.md)).
- Dry run: decode, re-encode and validate everything, produce nothing.

### P3 — Nice to Have

- Rewrite fields in flight (a JS mapping function) for anonymising prod data.

## Out of Scope

- Bulk mirroring / continuous replication. This is an interactive, bounded copy — use
  MirrorMaker for the other thing.
- Creating the destination topic or schema. The flow describes the destination topic
  before planning and refuses when it is missing; the producer itself has auto-creation
  off ([029](./029-connection-hygiene-and-fetch-latency.md)).

## Technical Notes

- Two client instances and **two separate schema caches**, keyed by profile. Sharing a
  cache across registries is exactly the bug this spec exists to prevent
  ([005](./005-schema-registry.md)).
- Build this last: it needs the decode, encode, produce and confirm machinery from
  [013](./013-byte-exact-replay.md)–[015](./015-craft-message.md) to already exist.

## Invariants

Enforces invariant 3 ([nfr/006](./nfr/006-data-fidelity.md)).

## File Structure

| File | Change |
|------|--------|
| `src/replay/copy.ts` | Cross-cluster decode/re-encode/produce — the plan, per field |
| `src/config/siblings.ts` | Sibling resolution, `topic_prefix` mapping, destination order |
| `src/views/CopyBar.tsx` | Destination bar + `copyBarRows`, the shared row count |
| `src/views/copyFlow.ts` | The second connection, the plan, the dialog |
| `src/schema/registry.ts` | `getVersionForId` — the source schema's *version*, for the dialog |

## Implementation Notes (P1)

- **Trigger `y`, confirm `shift+C`.** Different keys on purpose: a held key must not open a
  cross-cluster write and answer it. `y` is vim's yank and is not adjacent to `p`
  (byte-exact replay) or `c` (columns).
- **The bar is two steps**, at the bottom, borderless, and renders nothing when idle:
  destination profile (`j`/`k`, enter) → destination topic (an OpenTUI `<input>`, pre-filled
  with the prefix-mapped name, enter). `copyBarRows` is the single row count the table
  subtracts, as with the seek bar.
- **Per-field plan.** Value and key are resolved independently. A field carrying a Confluent
  schema id is re-encoded against the destination subject's latest, or the copy is refused;
  a field with *no* schema id references no registry, so its bytes mean the same thing on
  both clusters and are carried verbatim. The dialog states which of the two happened per
  field, so "verbatim" is never inferred. Headers are always verbatim.
- **The dialog's `schemas` lines** read
  `value  dg-orders-value v7 (id 42) → test-orders-value v3 (id 88)`. The source version
  needs `GET /schemas/ids/{id}/versions` — the payload embeds an id, not a version — and a
  registry that will not answer costs the version, not the copy.
- **A confirmed write is aimed by name.** `PendingWrite.cluster` carries the profile the
  bytes are for, and `writeTarget` resolves the client from it: bytes encoded for the
  destination registry are meaningless anywhere else, so the produce goes to the cluster the
  dialog named or to none.
- **The destination connection is kept** for the session (`password_cmd` shells out to a
  vault); picking a different destination replaces and disconnects the previous one, and
  `index.tsx` tracks every client it opened so shutdown closes both.

## Resolved Questions

- **What "no compatible schema" means.** Two failures, two messages: a destination subject
  that is *missing* is a refusal naming the subject and the source id; a subject that exists
  but *rejects this message* (a field added on the destination since) is reported as a
  validation failure with the offending path (`value.Channel`), not as "incompatible" —
  which would leave the user diffing two schemas by hand. Neither ends in raw bytes. A
  destination schema that *dropped* a field the message has is refused the same way
  (`value.Note`): avsc encodes field by field and ignores the rest, so the alternative is a
  copy that looks applied and arrives with the field missing ([nfr/006](./nfr/006-data-fidelity.md)).
- **Whether an unframed value may be carried verbatim.** Yes, and it is not a fallback: the
  prohibition is on reaching for the source bytes *after* a registry lookup fails, which no
  branch does. Bytes with no schema id reference no registry. Refusing them would also make
  the common case — a plain string key on an Avro topic — uncopyable.
- **How "refuse a production destination unless it is the explicit target" is enforced.**
  `copyDestinations` sorts every prod profile last, so prod is never the row the bar opens
  on and reaching one takes a deliberate cursor move; the dialog then colours it, warns that
  it is declared prod, and — when the source is *not* prod — names the reversed direction
  explicitly. `allow_write` on the destination remains the hard gate.
- **Which cluster the write is gated on.** The destination: it is what gets written. The
  source profile's `allow_write` is irrelevant, and a prod *source* is only a read.
- **Partition.** Not carried across. The destination topic's partition count is its own, so
  the source partition number would be a coincidence at best and out of range at worst; the
  key routes the record as it routes every other producer's.

## Open Questions

- **A tombstone's key on a topic whose key subject differs.** Handled like any other key
  today (re-encoded, or verbatim when unframed), but a compacted destination topic whose
  key schema disagrees would silently fail to tombstone the record the user meant. Needs a
  real case before deciding.
- **The bar copies the message it was opened on**, not the row under the cursor — the same
  rule as the seek bar, and for the same reason (a tail keeps arriving). Deliberate.
