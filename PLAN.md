# topiq

Peek, filter, replay. Kafka without leaving the terminal.

A terminal UI for browsing Kafka topics, filtering messages with a JS API, and
replaying messages — sibling of [`monq`](../monq) (MongoDB TUI) and
[`lane`](../lane) (Jira TUI), same stack, same ethos.

## Why

- **In-house CLIs only know the platform clusters.** A wrapper CLI is usually
  built around the handful of clusters the platform team runs; a team's own
  cluster (Aiven, MSK, self-hosted) is unreachable from every blessed path, and
  the answer is a hand-rolled `kafkacat` invocation.
- **Web consoles misrender data.** Redpanda Console shows empty arrays as NULL
  and mangles big int64 values — a pain point acknowledged in more than one
  team's cheat sheet. A BigInt-safe JSON renderer fixes it.
- **Nothing does replay/produce.** The documented flow for "re-send that
  message" is consumer-group offset reset (scale down → edit group in console →
  scale up) or a warehouse backfill. Nothing covers "find message → tweak in
  $EDITOR → re-produce".
- Prior art is consume-only: `kaskade` (Python/Textual) and `ktea` (Go) have no
  JS filters, no replay, no registry-aware produce. The niche is open.

## Stack

Same as monq/lane:

- **Bun** — runtime, bundler, test runner
- **OpenTUI** (`@opentui/core` + `@opentui/react`) — React renderer for the terminal
- **React 19**, **TypeScript** strict, **oxlint** + **oxfmt**

Kafka-specific:

- **Kafka client — the one real decision, settle in hour one.**
  - `kafkajs`: pure JS, zero native-module risk under Bun, supports
    SASL_SSL + SCRAM-SHA-256 (exactly what Aiven needs). Downside: in
    maintenance limbo since ~2023.
  - `@confluentinc/kafka-javascript`: maintained (librdkafka binding), but a
    Node-API native addon — Bun compatibility is a bet to verify first.
  - Recommendation: spike both for 30 minutes; if the Confluent client loads
    clean under Bun, take it, else kafkajs is fine for a tool.
- **Schema registry / Avro**: `@kafkajs/confluent-schema-registry` handles the
  Confluent wire format (magic byte + schema id), registry fetch + cache, basic
  auth. Uses `avsc` underneath.

## Correctness invariants (non-negotiable)

1. **int64 → BigInt everywhere.** Message keys are Avro `long` (customer ids,
   order ids). Configure avsc to decode long as BigInt, render with a
   lossless JSON serializer. `Number` precision loss is exactly the Redpanda
   bug this tool exists to not have.
2. **Unmodified replay is byte-exact.** Re-produce the raw key/value/header
   bytes verbatim — no decode/re-encode round trip. The embedded schema id
   stays valid, zero drift risk.
3. **Cross-cluster replay is never byte-exact.** The schema id in the payload
   refers to the *source* registry. Copying prod → test must decode and
   re-encode against the destination registry. The UI must make this
   distinction explicit, not silent.

## Features

### Peek

- Topic list: partitions, watermarks, message counts (admin client).
- Message table with monq-style smart columns inferred from decoded values;
  sort, hide, horizontal scroll.
- Paging: from offset, from timestamp, tail/follow. "Latest N" needs watermark
  math (high watermark − N per partition) since Kafka can't read backwards.
- Detail pane: decoded key/value/headers + raw metadata (partition, offset,
  timestamp, schema id).
- Schema-variance tolerance: tombstones (null value), mixed event subtypes on
  one topic. Sample widely before inferring columns — one message misleads.

### Filter (JS API)

Two tiers, both compiled to a local predicate over
`{key, value, headers, partition, offset, timestamp}`:

- **Filter bar** (the 90% case): monq-style
  `key:12345 value.IsOnboarded:true value.UpdateDate>2026-08-01`, field-name
  autocomplete from the sniffed schema.
- **Raw JS escape hatch**: `(msg) => …`. Runs locally on the user's own creds —
  `new Function` is fine, no sandbox needed (unlike Redpanda's server-side
  filters).
- Live filtering over a streaming consumer with a bounded buffer (monq's
  backpressure pattern).

### Replay / produce

- Select message → re-produce to same topic: **raw bytes, same key, same
  headers** (invariant 2).
- Edit-then-replay: decode → `$EDITOR` (monq's tmux/$EDITOR pattern transplants
  directly) → validate against registry schema → encode → produce.
- Cross-cluster copy (prod → test): decode → re-encode against destination
  registry (invariant 3).
- Craft-from-scratch: new message from the topic's latest schema as a template.

### Consumer groups

- Group list: state, members, lag per partition.
- Offset seek (to offset / timestamp / beginning / end) — requires the group
  empty; show state and refuse otherwise. Subsumes the org's documented
  scale-down → console-edit → scale-up dance (the scale-down itself stays
  manual/kubectl).

## Safety

- **Read-only by default.** Produce and offset-write are gated per cluster
  profile in config (`allow_write = true`), plus a confirm dialog naming
  topic + cluster + env.
- Replaying an old snapshot re-applies stale state on snapshot-style topics —
  the confirm dialog should surface message age.

## Config

Lane-style TOML (`config.example.toml` checked in, real config local-only).
Cluster profiles:

```toml
[clusters.orders-test]
brokers = ["kafka-test.example.aivencloud.com:24748"]
registry = "https://kafka-test.example.aivencloud.com:24740"
sasl = { mechanism = "scram-sha-256", username = "svc-orders" }
password_cmd = "az keyvault secret show --vault-name my-vault-test --name <secret> --query value -o tsv"
topic_prefix = "test"
allow_write = false
```

- `password_cmd` — lazily shell out (KeyVault, 1Password, whatever); no secret
  ever lands in a file. This alone beats every documented manual flow.
- A prod profile is the same table with the prod broker, the prod vault and no
  `topic_prefix`. Aiven serves the registry on the broker host under a different
  port, so both URLs move together.
- Transport is SASL_SSL + SCRAM; the mechanism (256 vs 512) is per cluster, not
  a constant — confirm it against whoever runs the cluster rather than guessing.

## Risks

- Kafka client choice (above) — the only structural risk.
- kafkajs admin API coverage for offset ops (`setOffsets` exists; verify
  timestamp-based seek ergonomics).
- Very large topics: never buffer unboundedly; filters stream, UI caps rows.
- Aiven registry auth is basic-auth with the same SASL creds — verify the
  registry client passes them through cleanly.

## Milestones

1. **Spike**: client choice under Bun; connect to Orders test cluster,
   consume + Avro-decode 10 messages from
   `test-orders-customerupdated-v2`, BigInt keys
   intact. This de-risks everything.
2. **Peek**: topic list → message table → detail pane, offset/timestamp paging.
3. **Filter**: filter bar + JS escape hatch, streaming with bounded buffer.
4. **Replay**: byte-exact re-produce, then edit-in-$EDITOR flow, behind
   `allow_write`.
5. **Groups**: lag view + offset seek.
6. **Cross-cluster copy** (last — needs invariant 3 machinery).
