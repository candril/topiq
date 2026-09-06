<p align="center">
  <img src="site/src/assets/logo.png" alt="topiq" width="160" />
</p>

<h1 align="center">topiq</h1>

<p align="center">Peek, filter, replay. Kafka without leaving the terminal.</p>

> [!CAUTION]
> topiq is young, spec-first, and was largely written with an AI pair. It *writes* —
> replay, produce, offset seek — so every write is off by default per cluster and confirmed
> at the point of action. Point it at dev and test clusters first, and expect rough edges.

```sh
curl -fsSL https://raw.githubusercontent.com/candril/topiq/main/scripts/install.sh | bash
topiq --demo        # an offline demo cluster — no config, no broker
```

<img src="site/src/assets/topiq-demo.gif" alt="topiq demo" width="100%" />

---

### A topic that reads like a table

Open a topic and the latest 50 messages are there, newest first, with columns inferred from the decoded payload — nested fields become `customer.tier`, arrays become `[3 items]`. Every Avro `long` is a `BigInt`: an order id above 2^53 is printed exactly, never rounded, which is the console bug this tool was written to not have.

<img src="site/src/assets/screenshots/table.png" alt="The message table: newest first, columns inferred from the payload, BigInt ids intact" width="100%" />

### Filter with a grammar, or with JavaScript

`/` opens the filter bar: `field:value`, `field>x`, ranges, regex literals, negation, nested paths — typed by the field's decoded type. Fields autocomplete from what is loaded, one dotted segment at a time. `=` switches to a raw predicate that runs locally on your own credentials.

<img src="site/src/assets/screenshots/filter-suggest.png" alt="The filter bar with field suggestions" width="100%" />

### Replay a message — the same bytes

`p` re-produces the message under the cursor: raw key, value and headers, verbatim. No decode, no re-encode, so the embedded schema id stays valid and the bytes are provably identical. `e` edits it in `$EDITOR` first; `⇧N` crafts a new one from the subject's latest schema; `y` copies it to another cluster — decoded here, re-encoded there, and the dialog says so.

<img src="site/src/assets/screenshots/replay.png" alt="The replay confirm dialog naming cluster, env, topic and message age" width="100%" />

### Consumer groups, and the one write with no undo

`c` lists the groups consuming a topic with state, members and per-partition lag — undefined lag is `—`, never `0`. `o` moves a group's offsets to an offset, a timestamp, the beginning or the end, only when the group is `Empty`, checked again at the instant of the write.

<img src="site/src/assets/screenshots/groups.png" alt="Consumer groups with per-partition lag" width="100%" />

---

Full docs: **[candril.github.io/topiq](https://candril.github.io/topiq/)**

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/candril/topiq/main/scripts/install.sh | bash
```

Installs the latest release into `/usr/local/bin`, verifying the SHA256 first. Override
with `TOPIQ_INSTALL_DIR=~/.local/bin` or pin with `TOPIQ_VERSION=0.1.0`.

Then, before configuring anything:

```sh
topiq --demo
```

An offline demo cluster — a fictional shop's order topics, seeded consumer groups, real
Avro behind real schema ids. No config, no broker. **Writes work**: replay a message and
watch it land in the tail. `demo-prod` is the same cluster with `allow_write = false`, so
the guardrails are demonstrable too.

Or grab a binary from [Releases](https://github.com/candril/topiq/releases) —
`topiq-<os>-<arch>.gz`, checksums in `SHA256SUMS`.

From source, with [Bun](https://bun.sh):

```sh
git clone https://github.com/candril/topiq && cd topiq
bun install
just install-bin     # builds and installs to ~/.local/bin
```

## Configure

Cluster profiles live in `~/.config/topiq/config.toml`. Copy
[`config.example.toml`](./config.example.toml) and edit — it documents every key.

```toml
[clusters.orders-test]
brokers  = ["kafka-test.example.aivencloud.com:24748"]
registry = "https://kafka-test.example.aivencloud.com:24740"
sasl     = { mechanism = "scram-sha-256", username = "svc-orders" }

# The password is a *command*, run on demand. No secret is ever written to disk.
password_cmd = "az keyvault secret show --vault-name my-vault --name kafka-password --query value -o tsv"

ca_cert      = "~/.config/topiq/aiven-ca.pem"
topic_prefix = "test"
group        = "orders"
env          = "test"
allow_write  = false          # produce and offset writes stay off until you say so
```

Profiles sharing a `group` are environments of one logical cluster, which is what makes
"copy this message to the other environment" a single keystroke.

## What it does

- **Peek** — topic list with watermarks, message table with columns inferred from the
  decoded payload, detail pane with decoded key/value/headers and raw metadata.
- **Filter** — `key:12345 value.IsActive:true value.UpdatedAt>2026-08-01`, with ranges,
  regex and nested fields. `=` switches to a raw JS predicate that runs locally on your
  own credentials.
- **Live tail** — follow a topic with a bounded buffer; filters apply to the stream.
- **Replay** — re-produce a message byte-for-byte, or decode it into `$EDITOR`, edit,
  re-encode against its own schema and produce. Craft a new message from the topic's
  latest schema. Copy across clusters, decoding against the source registry and
  re-encoding against the destination's.
- **Consumer groups** — state, members, per-partition lag; seek a group's offsets to an
  offset, a timestamp, the beginning or the end.

`?` shows every binding. `Ctrl+P` opens the command palette.

## Correctness

Three invariants the tool exists to uphold:

1. **int64 → BigInt everywhere.** An Avro `long` never touches `Number`. Precision loss is
   the console bug topiq was written to not have.
2. **Unmodified replay is byte-exact.** The raw key, value and headers go back out
   verbatim — no decode/re-encode round trip, so the embedded schema id stays valid.
3. **Cross-cluster replay is never byte-exact.** Schema ids are registry-local, so a copy
   must re-encode — and the UI says so rather than silently corrupting a payload.

## Development

```sh
just run <profile> [topic]   # run it
just check                   # typecheck + lint + format
just test                    # unit tests
just build                   # dist/topiq
```

Specs come before code: [`specs/`](./specs/) is the feature record and
[`PLAN.md`](./PLAN.md) the product rationale.

## License

MIT
