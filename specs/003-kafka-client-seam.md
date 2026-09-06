# Kafka Client Seam

**Status**: In Progress — P1 built (`src/kafka/`); P2 lifecycle states and the P3 mock pending

## Description

The one abstraction that keeps the UI independent of a Kafka library, and the decision of
*which* library backs it. This is the single structural risk in the project
([`PLAN.md`](../PLAN.md) — Risks) and the subject of milestone 1.

## Capabilities

### P1 — Must Have

- A `KafkaClient` interface covering what the app needs and nothing more:
  `listTopics()`, `describeTopic()` (partitions + watermarks), `consume(range, onMessage)`,
  `produce(records)`, `listGroups()`, `describeGroup()`, `setOffsets()`.
- Exactly one implementation module; `index.tsx` is the only place it is chosen
  ([001](./001-app-shell.md)).
- Connect against a `ClusterProfile` ([002](./002-cluster-config.md)) with SASL_SSL +
  SCRAM-SHA-256.
- **Spike gate:** consume and Avro-decode 10 messages from
  `test-orders-customerupdated-v2` with BigInt keys intact before
  any UI work proceeds. ✅ **Passed** (`spike/consume.ts`): 10 messages across 5
  partitions, keys decoded as `bigint` only, value longs BigInt, watermark-seek paging.

### P2 — Should Have

- Connection lifecycle the UI can render: connecting / ready / retrying / failed, with the
  broker error text ([nfr/004](./nfr/004-reliability-and-errors.md)).
- Consumer instances are disposable — a new fetch range means a fresh consumer, not
  mutated state on a shared one.

### P3 — Nice to Have

- A mock client returning canned topics/messages so the UI is exercisable offline (monq's
  and lane's mock-provider pattern).

## Out of Scope

- Avro decoding — [005](./005-schema-registry.md). The seam deals in raw `Buffer`s.
- Anything admin beyond offsets and metadata — see Non-Goals in [000](./000-vision.md).

## Technical Notes

- `consume()` takes a *range descriptor*, not a subscription: `{from: offset|timestamp|
  beginning|latest-N, limit, follow}` ([009](./009-paging-and-fetch-modes.md)). Watermark
  math for `latest-N` lives above the seam so both clients behave identically.
- The seam always hands up **raw bytes** plus metadata; decoding is a layer above. This is
  what makes byte-exact replay possible at all ([013](./013-byte-exact-replay.md)).

## Open Questions

- ~~**Which client?**~~ **Resolved: `kafkajs`.** `@confluentinc/kafka-javascript` 1.10.0
  hard-crashes Bun 1.3.3 **on import** (native crash, not an exception — bun.report
  Mr1274e01c…). kafkajs connected first try with SASL_SSL + SCRAM-SHA-256 against the
  Aiven test cluster; its maintenance limbo is the accepted tradeoff.
- **Does the chosen client's admin API do timestamp-based offset seek ergonomically?**
  Implemented at the seam via `fetchTopicOffsetsByTimestamp` + `setOffsets` (with the
  empty-group refusal from [018](./018-consumer-group-offset-seek.md)); not yet
  exercised against a live group — verify when 018's UI lands.

## Decisions (from the spike)

- **~~`listTopics` does not survive a cluster of ~1900 topics.~~ Resolved: it no longer
  fetches watermarks.** Measured against `core-test` ([002](./002-cluster-config.md)): the
  old shape fanned out one `fetchTopicOffsets` per topic, and kafkajs serialises those
  behind a per-cluster "updating target topics" lock — 1893 concurrent calls exceeded the
  lock timeout and the call died with `KafkaJSLockTimeout`. Capping the fan-out at 32 got
  past that but took **132 s** and still lost ~15 topics to a kafkajs race
  (`Cannot destructure property 'partitions'` — those same topics answer fine alone). The
  clusters are small enough to have hidden both.
  The seam now splits the cost: `listTopics` returns `TopicSummary[]` from one
  `fetchTopicMetadata`, and `fetchWatermarks(names)` measures a named subset with a window
  of 8 and one retry per topic ([006](./006-topic-list.md)). A topic that still fails is
  omitted, not guessed; only an all-failed batch rejects, so a real fault still surfaces.

- **The Aiven brokers present a chain rooted in the Aiven *project CA* (self-signed,
  valid to 2030).** Default trust stores reject it (`SELF_SIGNED_CERT_IN_CHAIN`); the CA
  must be configured per cluster profile ([002](./002-cluster-config.md)). The server
  sends the full chain, so the CA is extractable via `openssl s_client -showcerts`.
- The registry (`:24740`) uses the same CA; the registry HTTP client needs it too.
- **kafkajs ships a gzip codec and nothing else.** Many clusters produce snappy
  batches, and an unregistered codec does not fall back — it throws `KafkaJSNotImplemented`
  inside the fetch decoder, which kills the consumer runner. The seam registers
  `kafkajs-snappy` (pure JS, one transitive dep) at module load. lz4 and zstd are still
  unregistered: nothing observed uses them, and a codec that is never exercised is a
  liability, not a feature — the crash now names the codec, so the next one is a two-line
  fix rather than an investigation.
- **A dead consumer rejects `done`.** kafkajs reports a fatal runner failure through its
  `CRASH` event, not through `run()`'s promise: the old shape left `done` pending forever
  and the message table sat on "loading" saying nothing. That is how the snappy failure
  hid ([nfr/004](./nfr/004-reliability-and-errors.md)). Follow mode awaits `done` for the
  same reason, even though a tail has no end.
- **kafkajs has no assign-only read** — a `groupId` is mandatory. The seam reads via an
  ephemeral `topiq-read-*` group with `autoCommit: false` and `consumer.seek` after
  `run()`, so no offset is ever committed ([009](./009-paging-and-fetch-modes.md)).
  Spec 009's "no consumer group of its own" is amended to "no *committed* group".
  What that group join costs a shared cluster, and the group-free read that would remove
  it, are [029](./029-connection-hygiene-and-fetch-latency.md)'s subject; the same spec
  turns auto topic creation off, names the OS user in `client.id` and the group id, and
  ends a window on the fetch's last offset rather than a delivered one.

## File Structure

| File | Change |
|------|--------|
| `src/kafka/types.ts` | `KafkaClient`, `RawMessage`, `TopicMeta`, range descriptors |
| `src/kafka/client.ts` | The chosen implementation |
| `src/kafka/mock.ts` | Offline fixture client (P3) |
