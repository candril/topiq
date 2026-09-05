# topiq Vision

**Status**: Draft

## What is topiq?

topiq is a terminal UI for Kafka: **peek** at topics, **filter** messages with a JS API,
and **replay** them — without leaving the terminal. Same stack and interaction philosophy
as [`monq`](../../monq) (MongoDB) and [`lane`](../../lane) (Jira). The name is *topic*,
distilled.

## Why it exists

Three gaps, all verified (see [`PLAN.md`](../PLAN.md) for the evidence):

1. **In-house CLIs can't reach team clusters.** A platform wrapper CLI knows the platform
   clusters and nothing else; a team's own Aiven/MSK cluster is unreachable from it.
2. **The web console misrenders data.** Empty arrays as NULL, mangled int64s — an
   acknowledged pain point. A BigInt-safe renderer fixes it
   ([nfr/006](./nfr/006-data-fidelity.md)).
3. **No org tool does replay.** Every documented flow is consumer-group offset reset or a
   BigQuery backfill. Nothing covers "find message → tweak in `$EDITOR` → re-produce"
   ([013](./013-byte-exact-replay.md), [014](./014-edit-and-replay.md)).

Prior art (`kaskade`, `ktea`) is consume-only: no JS filters, no replay, no
registry-aware produce. The niche is open.

## Core Philosophy

1. **Keyboard-first** — everything reachable via vim-style keys, no mouse
   ([020](./020-keyboard-navigation.md)).
2. **Correctness over convenience** — the three invariants in
   [nfr/006](./nfr/006-data-fidelity.md) are not negotiable. This tool exists because
   another tool got them wrong.
3. **Read-only by default** — producing and offset-writing are gated per cluster profile
   and confirmed at the point of action ([019](./019-write-safety.md)).
4. **Client-agnostic UI** — the UI depends on a domain `Message`/`Topic` shape, never on a
   Kafka library ([003](./003-kafka-client-seam.md), [004](./004-data-model.md)).
5. **Secrets stay out of files** — credentials are fetched lazily by shelling out
   (`password_cmd`); nothing lands on disk ([nfr/003](./nfr/003-security-and-credentials.md)).
6. **Bounded by construction** — Kafka topics are unbounded, terminals are not. Every
   stream has a bounded buffer and a capped view ([012](./012-live-tail.md)).

## Design Principles

- **Fast feedback** — navigation and local state changes are instant; broker I/O is async
  and never blocks input ([nfr/001](./nfr/001-performance.md)).
- **Discoverable, without chrome** — no persistent status bar; the view gets the full
  screen. Discoverability comes from the `?` help panel ([022](./022-help-panel.md)) and
  the `Ctrl+P` palette ([021](./021-command-palette.md)).
- **Explicit over silent** — a cross-cluster copy that must re-encode says so; a stale
  snapshot replay surfaces the message's age. Never a quiet lossy path.
- **Filter where the data is cheap** — filters run locally over the user's own stream, so
  a raw JS predicate needs no sandbox ([011](./011-js-filter.md)).

## Non-Goals (for now)

Listed so we don't drift into building them:

- **Cluster administration** — creating/deleting topics, changing partition counts, ACLs,
  broker config.
- **Scaling consumers** — the scale-down half of an offset reset stays manual/kubectl
  ([018](./018-consumer-group-offset-seek.md)).
- **Schema management** — registering, evolving, or deleting schemas. topiq reads the
  registry; it does not write it ([005](./005-schema-registry.md)).
- **Stream processing** — no joins, aggregates, or ksqlDB-style queries. Filter and read.
- **Persistent message archives** — no local database of consumed messages. Caching is a
  session-scoped buffer, not storage.
- **Non-Confluent wire formats** — Protobuf/JSON-Schema registry payloads until asked for.

## Target User

A developer who owns Kafka topics on a team cluster, debugs production incidents from the
terminal, and currently has no tool that both reaches their cluster and renders their data
correctly.
