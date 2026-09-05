# NFR: Data Fidelity

**Status**: Draft

## Requirement

topiq exists because another tool got this wrong. Message data is rendered and reproduced
without loss or silent transformation. The three invariants below outrank every feature:
violating one is a bug, not a tradeoff.

## Invariants

1. **int64 → BigInt everywhere.** Avro `long` values (message keys, ids, watermarks,
   offsets, lag) are decoded and carried as `BigInt`, never `Number`. `Number` precision
   loss above 2^53 is exactly the acknowledged web-console bug this tool exists to not have.
2. **Unmodified replay is byte-exact.** Re-producing an untouched message writes the raw
   key/value/header bytes verbatim — no decode/re-encode round trip — so the embedded
   schema id stays valid and there is zero drift
   ([../013-byte-exact-replay](../013-byte-exact-replay.md)).
3. **Cross-cluster replay is never byte-exact.** A schema id refers to its *source*
   registry, so copying between clusters must decode and re-encode against the destination.
   The UI states this explicitly rather than implying a copy
   ([../016-cross-cluster-copy](../016-cross-cluster-copy.md)).

## Criteria

- `avsc` is configured to decode `long` as `BigInt`, and this is asserted by a test against
  a real value above 2^53 — not assumed from a config option
  ([../005-schema-registry](../005-schema-registry.md)).
- Rendering goes through one BigInt-safe serialiser. `JSON.stringify` is never called on a
  decoded value directly.
- Empty arrays render as `[]`, empty objects as `{}`, `null` as `null`, and an **absent**
  field is visually distinct from a null one. Conflating these is the second acknowledged
  console bug.
- Tombstones (`value === null`) are a distinct rendered state, not a blank row and not an
  error ([../004-data-model](../004-data-model.md)).
- Offsets, watermarks and lag are computed in `bigint` end to end; no intermediate
  `Number` coercion in watermark math
  ([../009-paging-and-fetch-modes](../009-paging-and-fetch-modes.md)).
- Filter comparisons pick a comparator from the operand's decoded type, so a BigInt field
  compares as BigInt ([../010-filter-bar](../010-filter-bar.md)).
- The `$EDITOR` round trip preserves BigInts on the way out and back in
  ([../014-edit-and-replay](../014-edit-and-replay.md)).
- Raw bytes are retained alongside every decoded message, so invariant 2 is achievable at
  all ([../004-data-model](../004-data-model.md)).

## Notes

- These are the properties to write tests for first: they are invisible in a demo and
  catastrophic in production debugging — a wrong customer id looks exactly like a right one.
