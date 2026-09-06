---
title: Getting Started
description: From an empty config to a cluster family you can replay across.
---

topiq doesn't discover clusters — you declare them, one `[clusters.<name>]` table each. The
name doubles as the CLI argument, so pick short ones.

## 1. One cluster

```toml
# ~/.config/topiq/config.toml
[clusters.orders-test]
brokers  = ["kafka-test.example.aivencloud.com:24748"]
registry = "https://kafka-test.example.aivencloud.com:24740"
sasl     = { mechanism = "scram-sha-256", username = "svc-orders" }
password_cmd = "op read op://infra/kafka-orders-test/password"
ca_cert  = "~/.config/topiq/aiven-orders-ca.pem"
```

That is enough to peek. `topiq orders-test` connects, lists the topics with their watermarks,
and `Enter` on one opens the latest 50 messages.

Writes are **off**. Press `p` on a message and the status line says why:
`writes are disabled on orders-test — allow_write is false in the config`. That is deliberate:
the command is drawn disabled with its reason, not hidden and not failing at the broker.

## 2. Allow writes where you mean it

```toml
allow_write = true
```

Now `p` opens the confirm dialog instead. It names the action, the cluster and its environment,
the topic, the message count and — for a replay — the message's **age**, because replaying an
old snapshot onto a snapshot-style topic is the realistic way this tool causes damage. `⇧R`
confirms; `esc` cancels. There is no `y`.

## 3. Make it a family

The same cluster usually exists twice — test and prod — and topics mirror across them, often
under a prefix. Tell topiq:

```toml
[clusters.orders-test]
# …as above
topic_prefix = "test"
group = "orders"
env   = "test"
allow_write = true

[clusters.orders-prod]
brokers  = ["kafka-prod.example.aivencloud.com:24748"]
registry = "https://kafka-prod.example.aivencloud.com:24740"
sasl     = { mechanism = "scram-sha-256", username = "svc-orders" }
password_cmd = "op read op://infra/kafka-orders-prod/password"
ca_cert  = "~/.config/topiq/aiven-orders-ca.pem"
group = "orders"
env   = "prod"
# allow_write stays false
```

Two profiles sharing a `group` are environments of one logical cluster. The picker groups
them under `#orders`, the header shows the env everywhere the cluster name shows — prod in the
warning colour — and `y` on a message offers the sibling as the copy destination with the
topic prefix mapped: `orders.placed.v2` on prod becomes `test-orders.placed.v2` on test.

Prod-ness is the **declared** `env` (or an explicit `prod = true`), never guessed from a
hostname. A host with `prod` in its name declared `test` is test.

## 4. Copy prod → test

On `orders-prod`, open a topic, put the cursor on a message and press `y`. The destination
bar lists the other profiles, siblings first, prod never as the default row. `Enter` accepts
the destination, the topic name (already prefix-mapped) is editable, `Enter` again resolves
both registries, and the dialog shows what will actually happen:

```text
Copy 1 message   orders-prod → orders-test
source        orders.placed.v2-value  v2 (id 7)
destination   test-orders.placed.v2-value  v2 (id 41)
! not a byte copy: decoded against the source registry, re-encoded against the destination's
```

Schema ids are registry-local, so a cross-cluster copy is **never** byte-exact — and topiq
says so rather than silently corrupting a payload. `⇧C` writes. The destination's
`allow_write` is what gates it: prod stays read-only even as a copy target, and if you ever
do target prod, the dialog demands its name typed out.

## 5. Everything else

- `?` — the keymap, grouped by area.
- `^P` — the command palette: every action for the current screen, with its key.
- `--demo` — all of the above against an in-memory cluster, when you want to learn the keys
  before touching anything real.

The full key list is in [Key Bindings](/topiq/reference/key-bindings/); every config key is
in [Configuration](/topiq/reference/configuration/).
