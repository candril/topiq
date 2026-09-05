# Demo Mode

**Status**: In Progress — P1 and P2 built; P3 not started

## Description

`topiq --demo` opens a complete, offline cluster that exists only in memory: seeded topics,
Avro schemas, consumer groups and messages, behind the same [003](./003-kafka-client-seam.md)
seam the real transport sits behind. No config file, no broker, no registry, no network —
and **writes work**: a replay produces, the offset lands in the log, and the next tail shows
it.

It exists for three reasons, in increasing order of how much they matter:

1. **Evaluation.** Configuring SASL, a `password_cmd` and a project CA to find out whether
   a tool is worth configuring is the wrong order. `--demo` is the answer to "what does
   this actually look like".
2. **Development.** Every `useKeyboard` block and every hook effect in topiq is currently
   untested code ([specs/README](./README.md) says so in the status summary), because
   nothing in the test suite can open a socket and the only alternative is a live cluster.
   A deterministic in-process cluster is the substrate a render harness would need.
3. **Documentation, which is the reason it is being built now.** Every screenshot and
   every frame of a demo gif taken against a real cluster shows real broker names, real
   topic names and real payloads. Sanitising text is a grep; sanitising a PNG is not
   possible after the fact. Demo mode is what makes [028](./028-docs-screenshots-and-gif.md)
   safe to run at all.

Writes are enabled deliberately. topiq's reason to exist is the replay path — a demo that
can only peek demonstrates the half of the tool that `kaskade` and `ktea` already do.

## Capabilities

### P1 — Must Have

- **`topiq --demo`** starts with a synthesised profile set and never reads
  `~/.config/topiq/config.toml`. It must work on a machine that has no config at all,
  which is the evaluation case.
- **Two profiles, one group.** `demo-test` (`env = "test"`, `allow_write = true`) and
  `demo-prod` (`env = "prod"`, `allow_write = false`), sharing `group = "demo"`. Two
  profiles are what make the picker's grouping, the env switch
  ([023](./023-cluster-groups-and-environments.md)), cross-cluster copy
  ([016](./016-cross-cluster-copy.md)) and the prod guardrail
  ([019](./019-write-safety.md)) demonstrable rather than described.
- **A full `KafkaClient`** ([003](./003-kafka-client-seam.md)): `listTopics`,
  `fetchWatermarks`, `describeTopic`, `consume`, `produce`, `listGroups`, `describeGroup`,
  `resolveOffsets`, `setGroupOffsets`, `disconnect`. Not a subset — a seam implemented
  partially is a seam that lies, and every view that hits a missing method in a demo is a
  view that cannot be screenshotted.
- **A full `SchemaRegistry`** ([005](./005-schema-registry.md)): `getSchemaById`,
  `getLatestSchema`, `getVersionForId`. Real Avro schemas parsed by `avsc`, real Confluent
  wire framing (magic byte + big-endian id) around real encoded bytes — **not** a stub that
  returns a decoded object. Anything less and the demo exercises none of the code the
  invariants live in.
- **Writes land.** `produce` appends to the in-memory log and returns the real
  `{ partition, offset }`; a subsequent read or tail sees the message. `setGroupOffsets`
  moves the committed offsets and the lag in the group view changes. A write path that
  fakes its acknowledgement teaches the reader something false about the tool.
- **`demo-prod` refuses.** Its `allow_write = false` is what shows the gate's refusal, and
  a copy targeting it shows the prod warning. Both profiles writable would hide the whole
  safety story.
- **Seeded to exercise the invariants and the edge cases** — see *The seed* below. In
  particular: BigInt keys above 2^53 ([nfr/006](./nfr/006-data-fidelity.md)), a tombstone,
  a message whose schema id is not in the registry (the `decode failed` row,
  [nfr/004](./nfr/004-reliability-and-errors.md)), and two event subtypes on one topic so
  column inference has something to infer.
- **Deterministic.** The same keystrokes produce the same screen. No `Math.random`, no
  `Date.now()` in message content, fixed schema ids, fixed offsets.
- **Visibly a demo.** The status line says so. A reader who lands on a screenshot must not
  believe they are looking at someone's production topic, and a user who forgets which mode
  they are in must not think a replay went to a real broker.

### P2 — Should Have

- **`TOPIQ_DEMO_EPOCH`** pins the timestamp anchor to a fixed instant. Without it the seed
  is anchored to *now* minus fixed offsets, so ages read naturally ("3m ago") at the cost
  of absolute timestamps that move; with it, a capture run is pixel-reproducible
  ([028](./028-docs-screenshots-and-gif.md) sets it). Both properties are wanted, they just
  cannot both be the default.
- **The tail produces.** While a demo consumer is following, a new message arrives every
  ~1.5 s from a fixed cycle. Live tail ([012](./012-live-tail.md)) is otherwise a static
  screen with the word "following" on it, which is exactly the frame that makes a gif look
  fake.
- **Plausible latency.** A small fixed delay per call (connect ~400 ms, list ~150 ms,
  window ~250 ms) so the loading indicators ([025](./025-loading-indicators.md)) are
  visible. Instant answers make the spinners unreachable and the tool feel unlike itself.
  `TOPIQ_DEMO_LATENCY=0` disables it for tests.
- **Consumer groups with a story**: one `Empty` group that offset-seek will accept, one
  `Stable` group it must refuse ([018](./018-consumer-group-offset-seek.md)), and one with
  undefined lag so the `—` and `+?` rendering is reachable
  ([017](./017-consumer-groups.md)).
- **A topic large enough to page.** One topic with ~1,900 topics' worth of *names* is
  wrong — but one topic with more messages than the default 50 makes `n`, `o`, `t` and the
  window cap mean something.

### P3 — Nice to Have

- **Fall back to demo when there is no config**, the way `lane` opens its mock board. Sound
  for evaluation, and it removes the "not found — create it" dead end. Deferred because it
  changes what a *missing* config means, and that is currently an honest error
  ([002](./002-cluster-config.md)).
- A second demo registry whose ids differ from the first, so a cross-cluster copy visibly
  re-encodes `subject v2 (id 7)` → `subject v2 (id 41)` rather than asserting it does.
- Deliberate faults on demand: a topic whose watermark fetch fails, a consumer that dies
  mid-read — the nfr/004 paths have no other way to be seen.

## Out of Scope

- **A Kafka protocol emulator.** Nothing speaks the wire protocol; the fake implements the
  `KafkaClient` interface directly. Testing kafkajs is not this spec's job — the live
  `just smoke` is.
- **Persistence.** The log lives for the process. A demo that remembers yesterday's replay
  is a demo that stops being reproducible, which defeats the documentation use.
- **Compression, transactions, exactly-once, ACLs, multi-broker metadata.** None of it is
  visible in the UI, so none of it earns a line of fake.
- **Recording the screenshots and the gif** — [028](./028-docs-screenshots-and-gif.md).
- **Replacing the test fakes.** `src/seek/run.test.ts` and `src/replay/produce.test.ts`
  have their own narrow fakes and should keep them: a unit test wants a stub it can bend
  per-case, not a seeded cluster it has to navigate. If they converge later, that is a
  refactor, not a requirement.

## The seed

Enough to exercise every view, and no more. Anchored at the epoch (see `TOPIQ_DEMO_EPOCH`),
newest first as the window renders it ([007](./007-message-table.md)).

| Topic | Partitions | Shape |
|---|---|---|
| `orders.placed.v2` | 3 | The main topic. `long` key (order id, above 2^53), record value with nested `customer`, an `items` array, a `decimal`-ish string, and an `enum`. ~400 messages. |
| `orders.status-changed.v1` | 2 | Two event subtypes on one topic, so inferred columns differ per row and the "sample widely" logic ([007](./007-message-table.md)) has something to chew. Includes one **tombstone** (null value). |
| `customers.updated.v1` | 1 | Small and quiet — the topic to demo a produce into, because the result is visible immediately. Includes one message framed with a **schema id the registry does not have**, which renders `decode failed`. |
| `_internal.offsets` | 1 | Hidden behind `i` ([006](./006-topic-list.md)) — the toggle needs something to toggle. |

Groups: `order-processor` (Stable, lag on two partitions — seek refuses),
`analytics-sink` (Empty — seek accepts), `legacy-reader` (no committed offset on one
partition — lag renders `—` and the total `+?`).

## Technical Notes

- **`src/demo/` is the home**, not `src/kafka/`: the seam's real implementation and its
  fake are peers, and burying a fake inside the transport module invites one to import the
  other. Three files — `client.ts` (the `KafkaClient`), `registry.ts` (the
  `SchemaRegistry`), `seed.ts` (schemas + messages + groups, pure data and the encoder that
  frames it).
- **`index.tsx` stays the only place a transport is chosen** ([003](./003-kafka-client-seam.md)).
  `--demo` short-circuits `startup()` to return the synthesised profiles, and
  `connectCluster` branches on a demo profile to build the fake pair instead of
  `createKafkaClient` + `createRegistry`. No `fetchSecret`, no `readFileSync` of a CA.
- **Messages are stored encoded.** The seed encodes each value with `avsc` against its
  schema and frames it Confluent-style once, at startup; `consume` hands out those bytes.
  This is what makes byte-exact replay ([013](./013-byte-exact-replay.md)) a real assertion
  in demo mode rather than a claim — the produced bytes can be compared to the source
  bytes.
- **`ClusterProfile` needs no new field.** A demo profile is an ordinary profile whose
  `brokers` are `["demo"]`; the branch is on a `demo` marker the synthesiser sets, kept out
  of the TOML schema so no real config can ever name itself into demo mode.
- **`consume` honours `range`, `startAt`, `limit`, `partition` and `follow`** against the
  in-memory log. The follow path is the one with real behaviour to get right: it must keep
  delivering past the high watermark and resolve `done` only at `limit` or `stop()`.
- **Latency is one helper**, not a `setTimeout` sprinkled per method, so `TOPIQ_DEMO_LATENCY`
  has exactly one place to switch off.
- The fake must not import kafkajs, and a lint rule or a test asserting that is cheap
  insurance against a future edit quietly reconnecting the demo to the network.

## File Structure

| File | Change |
|------|--------|
| `src/demo/seed.ts` | New — schemas, messages, groups; encodes and frames at startup |
| `src/demo/client.ts` | New — the full `KafkaClient` over the in-memory log, writes included |
| `src/demo/registry.ts` | New — the full `SchemaRegistry` over the seeded schemas |
| `src/demo/profiles.ts` | New — the two synthesised `ClusterProfile`s |
| `src/index.tsx` | `--demo` flag; `startup()` and `connectCluster` branch on it |
| `src/demo/*.test.ts` | New — the fake honours ranges, `produce` is readable back, seek refuses a non-Empty group |
| `README.md` | `topiq --demo` as the first thing after install |

## Open Questions

- **Does `--demo` belong in the released binary, or behind a build flag?** In, currently:
  the evaluation case is the point and the seed is a few hundred KB. Revisit only if the
  seed grows into something that dominates the binary.
- **Should the demo write path warn that it is not a real broker at the confirm dialog?**
  The dialog names cluster, topic and age ([019](./019-write-safety.md)), and `demo-test`
  is visibly the cluster — but a screenshot of that dialog is exactly the frame someone
  might mistake for a real produce. Leaning yes, as a line in the dialog rather than a
  second confirmation.
- **How many messages before the seed is a liability?** ~400 encodes fast enough to be
  invisible at startup, but it is guesswork until measured. Resolve by measuring, not by
  picking a number.
