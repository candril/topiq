# NFR: Reliability & Errors

**Status**: Draft

## Requirement

Failures are visible, explained, and recoverable. Nothing crashes the app, and nothing
fails silently — especially not on a write path.

## Criteria

- A broker/registry error renders as a message naming the cluster and the operation, with
  the broker's own text; the app stays usable and retryable.
- Connection state is visible (connecting / ready / retrying / failed), not inferred from
  an empty view ([../003-kafka-client-seam](../003-kafka-client-seam.md)) — every wait
  carries a live indicator, so a stalled network is distinguishable from a wedged process
  ([../025-loading-indicators](../025-loading-indicators.md)).
- **A read that dies says so.** A consumer that stops mid-read must surface its error, not
  leave the view waiting on a promise that will never settle: an unimplemented compression
  codec presented as an eternal "loading" until the seam started rejecting on kafkajs's
  `CRASH` event ([../003-kafka-client-seam](../003-kafka-client-seam.md)).
- A message that fails to decode degrades to metadata + hex, and does not remove other
  rows ([../008-message-detail](../008-message-detail.md)).
- A malformed filter or a throwing JS predicate is reported inline; the previous result
  set stays on screen ([../010-filter-bar](../010-filter-bar.md),
  [../011-js-filter](../011-js-filter.md)).
- Write failures name what did and did not happen. A partially applied batch (produce or
  offset seek) reports exactly which messages/partitions succeeded
  ([../018-consumer-group-offset-seek](../018-consumer-group-offset-seek.md)).
- Dropped rows are announced, never silent — buffer eviction
  ([../012-live-tail](../012-live-tail.md)) and window truncation
  ([../007-message-table](../007-message-table.md)) both say so in the header.
- Shutdown disconnects consumers/producers; the process exits rather than hanging on an
  open socket.
- An unhandled error restores the terminal before it surfaces
  ([002-terminal-compatibility](./002-terminal-compatibility.md)).

## Notes

- Kafka has no undo. Reliability on the write path means *not attempting* an unsafe write
  ([../019-write-safety](../019-write-safety.md)) rather than recovering from it.
