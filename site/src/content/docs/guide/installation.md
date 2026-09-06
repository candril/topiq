---
title: Installation
description: Install topiq, try the demo, then point it at a cluster.
---

## Install

Prebuilt binaries for macOS (Apple Silicon and Intel) and Linux (x64 and arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/candril/topiq/main/scripts/install.sh | bash
```

The installer detects your platform, downloads the latest
[release](https://github.com/candril/topiq/releases), verifies its SHA256 against the
release's `SHA256SUMS`, and puts `topiq` in `/usr/local/bin`. Two variables change that:

```sh
TOPIQ_INSTALL_DIR=~/.local/bin …   # somewhere else on your PATH
TOPIQ_VERSION=0.1.0 …              # a specific release
```

Or download `topiq-<os>-<arch>.gz` from the releases page by hand, `gunzip` it, and put it on
your `PATH`.

### From source

topiq is a Bun application, so a clone runs as it is:

```sh
git clone https://github.com/candril/topiq.git
cd topiq
bun install
bun scripts/build.ts   # → dist/topiq, a standalone binary
```

With [just](https://github.com/casey/just): `just build`, or `just install-bin` to build and
install it to `~/.local/bin`. `just dev` runs from source with hot reload, `just demo` the same
against the demo cluster.

## Requirements

- A Kafka cluster reachable over **SASL_SSL with SCRAM** (`scram-sha-256` or `-512`) and a
  **Confluent-compatible schema registry** using the same credentials as basic auth. Aiven,
  Confluent Cloud and most managed offerings look like this.
- A terminal with truecolor and a decent Unicode set — WezTerm, Ghostty, kitty, iTerm2,
  Alacritty are all fine.
- **[Bun](https://bun.sh)** 1.x only if you build from source.

## Try it first

```sh
topiq --demo
```

opens an offline demo cluster: a fictional shop's order topics with real Avro schemas behind
real schema ids, keys above 2^53, a tombstone, one message that fails to decode, seeded
consumer groups, and a producer that keeps the tail alive while you follow. **Writes work** —
replay a message and watch it land — and are forgotten on exit. `demo-prod` is the same
cluster with writes disabled, so the guardrails are visible too.

Press `?` for the keymap, `q` to quit.

## Credentials

topiq needs a broker list, a registry URL, a SASL username — and a **command** that prints
the password:

```toml
# ~/.config/topiq/config.toml
[clusters.orders-test]
brokers  = ["kafka-test.example.aivencloud.com:24748"]
registry = "https://kafka-test.example.aivencloud.com:24740"
sasl     = { mechanism = "scram-sha-256", username = "svc-orders" }
password_cmd = "az keyvault secret show --vault-name my-vault --name kafka-password --query value -o tsv"
```

`password_cmd` runs on demand — once per connection — and its trimmed stdout is the password.
Nothing is ever written to disk. Vault, 1Password (`op read …`), `pass`, `security
find-generic-password` — anything that prints a secret works.

:::caution
The password lives in memory for the session, is sent only to the configured brokers and
registry, and is never logged or included in an error message. The config file itself
should be `0600`: it names your vault, not your secret, but it is still a map.
:::

Managed clusters usually present a certificate chain rooted in a project CA that no default
trust store accepts. Point `ca_cert` at the PEM; it applies to the brokers **and** the
registry:

```toml
ca_cert = "~/.config/topiq/aiven-ca.pem"
```

## First run

```sh
topiq                  # the cluster picker
topiq orders-test      # connect straight to a profile
topiq orders-test orders.placed.v2    # …and open a topic
```

A broken config does not stop the shell from booting: topiq comes up with no cluster and the
reason on the status line. Continue with [Getting Started](/topiq/guide/getting-started/) for
the full config.

## Files topiq reads and writes

| Path | What |
| --- | --- |
| `~/.config/topiq/config.toml` | Your cluster profiles. topiq only reads this. `TOPIQ_CONFIG` overrides the path. |
| `~/.cache/topiq/topics.json` | The last topic listing per cluster, for an instant first paint. Best-effort; deleting it costs one refresh. |

Nothing else. No secret, no offset, no history is written anywhere.
