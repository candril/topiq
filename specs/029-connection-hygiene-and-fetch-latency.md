# Connection Hygiene & Fetch Latency

**Status**: In Progress — P1 done; P2 (no consumer group, batched watermarks) pending
measurement

## Description

What a shared cluster sees when topiq connects, and why opening a topic is slow. The two
are the same subject: every avoidable round trip is also a line in a broker log, a member
of a consumer group, or a row in an admin's lag dashboard. topiq is a viewer run by a
person against infrastructure that other people own, so it must be a well-behaved tenant
before it is a fast one ([000](./000-vision.md) Non-Goals: no admin surface beyond offsets).

The audit that produced this spec is in the round-trip ledger below. The one structural
cause — reading through a consumer group because kafkajs has no assign-only read
([003](./003-kafka-client-seam.md)) — is P2, because fixing it means driving kafkajs's
private fetch path and the decision needs a measurement first (Open Questions).

## Capabilities

### P1 — Must Have (a good tenant)

- **Never create a topic.** kafkajs defaults `allowAutoTopicCreation` to true on producers
  and consumers; on a broker with `auto.create.topics.enable` a mistyped copy destination
  ([016](./016-cross-cluster-copy.md)) would create it with broker defaults. Both are
  explicitly false, and the copy flow describes the destination topic before it plans —
  a topic that does not exist is a refusal naming topic and cluster.
- **Attributable.** Every request carries `client.id = topiq/<os user>@<host>`, and the
  ephemeral read groups are `topiq-read-<os user>-<random>`, so a broker log, a quota
  or a lag exporter says *who*, not just "topiq". The prefix stays
  `topiq-read-` so [017](./017-consumer-groups.md)'s filter is unchanged.
- **A finite window ends when the partition ends, not when a message says so.** The end
  of a partition is the fetch response's high watermark, never `offset ≥ high − 1` on a
  delivered record: on a transactional topic the record at `high − 1` is a commit marker
  the client filters out, and on a compacted one it may be a removed tombstone. Either
  left the window on "loading" forever — the silent stall
  [nfr/004](./nfr/004-reliability-and-errors.md) forbids.
- **One describe per group list, one watermark read per topic.** The groups pane
  ([017](./017-consumer-groups.md)) describes every group in one `DescribeGroups` and
  reads the topic's watermarks once; only `OffsetFetch` is per group, at a concurrency
  of 8. Before this, a list of N groups cost N `DescribeGroups` and N identical
  `ListOffsets` on top of the N `OffsetFetch`.
- **Observable.** `TOPIQ_KAFKA_LOG=<path>` appends kafkajs's debug log to that file,
  token-shaped strings redacted ([nfr/003](./nfr/003-security-and-credentials.md)).
  Never the terminal — that is the alternate screen. Every line of the ledger below is
  visible in one such run, which is how the P2 measurement is taken.
- `connectionTimeout` 5 s and `requestTimeout` 30 s, set explicitly rather than
  inherited: the kafkajs default of 1 s tears down a slow TLS handshake to a remote
  cluster and retries with backoff, which reads as a random multi-second stall.

### P2 — Should Have (fast)

- **Read without joining a consumer group.** Removes the `JoinGroup`/`SyncGroup`/
  `LeaveGroup` cycle, the group-metadata writes to `__consumer_offsets`, the
  `group.initial.rebalance.delay.ms` stall (3 s by default, paid per window and again per
  follow toggle), the coordinator handshake, and the `topiq-read-*` litter entirely.
  Route decided by the Open Question below.
- **Batch the topic-list watermarks.** `fetchWatermarks(names)` issues one `ListOffsets`
  per broker for all named topics instead of one metadata refresh plus two serialized
  `ListOffsets` per topic under kafkajs's target-topics mutex ([006](./006-topic-list.md);
  the `KafkaJSLockTimeout` note in `src/kafka/pool.ts` *is* that mutex).
- One metadata pass in `listTopics`; resolve the window's start offsets once instead of
  in `describeTopic` and again in `consume`.

### P3 — Nice to Have

- Baseline and target numbers for "cluster select → topic list painted" and
  "topic open → first row", measured against a real cluster and recorded here.

## Out of Scope

- Consumer reuse across windows (keep a consumer and `seek()` on range change). It is the
  right interim fix only if P2's group-free read is deferred, and dead weight once it
  lands — do not build both.
- Registry connection pooling. Bun may not pool `fetch` across differing per-request
  `tls.ca`; it costs one handshake per cold schema id and is cached after. Measure first.
- Anything ACL-shaped: which permissions a profile's user needs is the admin's decision;
  topiq's job is to need as few as a viewer can.

## The round-trip ledger (as built before this spec)

Per window open, with the kafkajs seam:

| # | Step | Cost |
|---|------|------|
| 1 | `describeTopic` | metadata refresh + 2 sequential `ListOffsets` |
| 2 | `consume` → `fetchPartitions` | the same 2 `ListOffsets` again |
| 3 | `consumer.connect()` | new broker pool: TCP + TLS + ApiVersions + SASL |
| 4 | `FindCoordinator` + connect | a second TLS + SASL when the coordinator is another node |
| 5 | `JoinGroup` ×2 | first answers `MEMBER_ID_REQUIRED`; second waits out the rebalance delay |
| 6 | leader path | another metadata refresh |
| 7 | `SyncGroup`, `OffsetFetch`, `ListOffsets` | resolves a default position we immediately `seek()` away from |
| 8 | per-partition leader connects | TLS + SASL per broker holding a partition |
| 9 | `disconnect()` | `LeaveGroup` + close every socket |

`kafka.consumer()`, `kafka.admin()` and `kafka.producer()` each build their own `Cluster`,
so none of 3–8 reuse the admin's connections. Follow mode repeats 3–9 for its own group.

## Technical Notes

- The P1 items live entirely in `src/kafka/client.ts` and the seam. Only the group batch
  changes `KafkaClient`: `describeGroups(groupIds, topic)` returns one entry per id, `null`
  where that group's offsets could not be read, so [017](./017-consumer-groups.md)'s
  "rows whose detail failed stay, with unknown lag" survives the batching. `describeGroup`
  stays for the seek flow ([018](./018-consumer-group-offset-seek.md)), which needs one
  group at one moment.
- End-of-partition detection uses `eachBatch`: a batch carries the partition's
  `highWatermark` and `lastOffset()`, and kafkajs computes `lastOffset()` from the high
  watermark when every record in the batch was filtered. `eachMessage` never sees either.
- The log sink is a kafkajs `logCreator`. It writes through the same token-shaped
  redaction `password_cmd` failures use; kafkajs does not log the SASL secret, but a
  debug log is exactly the file someone pastes into a ticket.

## Open Questions

- **How is the group-free read built?** Two routes, decided by a 15-minute spike:
  1. Drive kafkajs's cluster directly (`findLeaderForPartitions` + `broker.fetch` with
     its own batch decoder — what `admin` already does for offsets). Stays inside
     `client.ts`, the seam does not move; the bet is on a private API of a library that
     is pinned and effectively unmaintained.
  2. Re-test `@confluentinc/kafka-javascript` under current Bun. It crashed on import
     when [003](./003-kafka-client-seam.md) was written and has had Bun fixes since; it
     has a real `assign()`. Larger blast radius, no private-API bet.
  Resolve before P2. Measure first: with `TOPIQ_KAFKA_LOG` set, the gap between the second
  `JoinGroup` and its response says whether the broker's rebalance delay is the 3 s it
  defaults to. If it is under 500 ms the group join is not the main cost and P2's
  batched watermarks become the lever.

## File Structure

| File | Change |
|------|--------|
| `src/kafka/client.ts` | auto-create off, attributable ids, timeouts, `eachBatch` end detection, `describeGroups` |
| `src/kafka/identity.ts` | `client.id` and group-id builders from the OS user and host |
| `src/kafka/log.ts` | `TOPIQ_KAFKA_LOG` file sink |
| `src/kafka/types.ts` | `describeGroups` on the seam |
| `src/views/useGroups.ts` | one batched describe instead of a per-group fan-out |
| `src/views/copyFlow.ts` | destination topic must exist before a copy is planned |
| `src/demo/client.ts` | `describeGroups` for the demo cluster |
