---
title: Configuration
description: Every key in ~/.config/topiq/config.toml.
---

topiq reads one file, `~/.config/topiq/config.toml` (or the path in `TOPIQ_CONFIG`), and
never writes it. It holds cluster profiles and nothing else — no secrets, no state.

```toml
[clusters.orders-test]
brokers  = ["kafka-test.example.aivencloud.com:24748"]
registry = "https://kafka-test.example.aivencloud.com:24740"
sasl     = { mechanism = "scram-sha-256", username = "svc-orders" }
password_cmd = "az keyvault secret show --vault-name my-vault-test --name kafka-orders-password --query value -o tsv"
ca_cert  = "~/.config/topiq/aiven-orders-ca.pem"
topic_prefix = "test"
group = "orders"
env   = "test"
allow_write = false
```

A commented copy of every key ships as
[`config.example.toml`](https://github.com/candril/topiq/blob/main/config.example.toml).

## Keys

One `[clusters.<name>]` table per profile. The name is the CLI argument (`topiq orders-test`)
and what every dialog shows, so keep it short and unambiguous.

| Key | Required | Meaning |
| --- | --- | --- |
| `brokers` | yes | Bootstrap brokers, `"host:port"` strings. |
| `registry` | yes | Schema registry URL, `http(s)`. Aiven serves it on the broker host under a different port. It authenticates with the SASL credentials below as basic auth. |
| `sasl` | yes | `{ mechanism, username }`. `mechanism` is `"scram-sha-256"` or `"scram-sha-512"` — per profile, because two clusters in one org routinely disagree. |
| `password_cmd` | yes | A shell command whose trimmed stdout is the password. Run on demand, once per connection; the result is never stored, logged or written. |
| `ca_cert` | no | Path to a PEM CA bundle; `~` expands. Needed for any cluster whose chain roots in a private CA (Aiven's project CA, for one). Applies to brokers **and** registry. |
| `topic_prefix` | no | A namespace: filters the topic list to it, and is what cross-cluster copy strips and re-adds when mapping a topic to the sibling. |
| `group` | pair | The logical cluster family. Profiles sharing a `group` are environments of one cluster. |
| `env` | pair | This profile's environment. `group` and `env` come as a pair — set both or neither. |
| `prod` | no | Explicit prod-ness. Defaults to `env == "prod"`; set it when your prod env has another name. Never inferred from hostnames. |
| `allow_write` | no | Default **false**. Gates every produce and the offset seek on this profile. |

Unknown keys are errors, with a hint when the camelCase spelling was used by mistake. A
broken file does not stop topiq from starting: it comes up with no cluster and the reason
on the status line.

## Secrets

`password_cmd` is the only way a secret enters topiq. Anything that prints one works:

```toml
password_cmd = "op read op://infra/kafka-orders-test/password"
password_cmd = "pass show kafka/orders-test"
password_cmd = "security find-generic-password -a svc-orders -s kafka-orders-test -w"
password_cmd = "az keyvault secret show --vault-name my-vault --name kafka-password --query value -o tsv"
```

The command runs through a shell, so quoting is yours. Its stdout is trimmed and used as the
password for the brokers and, as basic-auth, the registry. It is held in memory for the
session and sent nowhere else.

## Environments

The `group`/`env` pair is what makes topiq understand "this cluster, other environment":

- The **picker** groups profiles under `#<group>` and shows the env beside each.
- The **header** shows the env wherever the cluster name shows, prod in the warning colour.
- **Cross-cluster copy** offers the sibling (same group, other env) as the default destination,
  with `topic_prefix` mapped across.
- **Prod** is `prod = true`, or `env = "prod"` — a declaration. A host that looks like prod but
  is declared `test` is test.

## Environment variables

| Variable | Effect |
| --- | --- |
| `TOPIQ_CONFIG` | Path to the config file. |
| `EDITOR` | Used for viewing a message, editing before replay, and crafting. Defaults to `vi`. |
| `TOPIQ_DEMO_EPOCH` | Demo mode only: pins the timestamp anchor (ISO 8601 or epoch millis) so a run is reproducible. |
| `TOPIQ_DEMO_LATENCY` | Demo mode only: `0` removes the simulated round-trip delays. |
