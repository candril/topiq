# Changelog

All notable changes to topiq are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the release workflow lifts
the section matching a tag into that release's notes — an unwritten entry ships an empty
release, so write it before tagging.

## [Unreleased]

## [0.1.0] - 2026-09-06

First release. Read-only paths are exercised against a live cluster; every write path is
built and unit-tested but has not yet produced a byte to a real broker.

### Added

- **Peek** — cluster picker, topic list with lazy watermarks, message table with inferred
  columns, and a detail pane with decoded key/value/headers plus raw metadata.
- **Filter** — a `field:value` bar with ranges, regex and nested fields, a `=` JS predicate
  escape hatch, and live filtering over a streaming consumer with a bounded buffer.
- **Replay** — byte-exact re-produce (`p`), edit-in-`$EDITOR` then replay (`e`), craft from
  the latest schema (`shift+N`), and cross-cluster copy (`y`) that decodes against the
  source registry and re-encodes against the destination's.
- **Consumer groups** — state, members and per-partition lag (`c`), plus offset seek (`o`)
  to an offset, a timestamp, the beginning or the end.
- **Write safety** — every mutation passes one gate: `allow_write` on the profile plus a
  confirm dialog naming cluster, topic and message age.
- **BigInt everywhere** — Avro `long` decodes to `BigInt` and renders losslessly; a value
  never round-trips through `Number`.
- **Config** — TOML cluster profiles with `password_cmd`, so no secret is ever written to
  disk; `group`/`env` model a cluster family across environments.
- Command palette (`^p`), help panel (`?`), and column navigation with type-aware sort.
- **Demo mode** — `topiq --demo` opens a seeded in-memory cluster behind the same client
  seam: real Avro behind real schema ids, keys above 2^53, a tombstone, a decode failure,
  seeded consumer groups, live arrivals while following. Writes work and are forgotten on
  exit. No config, no network.
- **Docs** — a site at candril.github.io/topiq, with every screenshot and the README gif
  generated from the demo cluster by `just shots` / `just demo-gif`.
- The message window is newest first; `g` is the live edge while following.

### Fixed

- A window on a transactional topic no longer sits on "loading" forever: the end of a
  partition is now read off the fetch, and the commit marker at the tail — which the
  client filters out before delivery — no longer hides it.
- The producer and consumer can no longer create a topic. A mistyped cross-cluster copy
  destination is refused by name instead of being created with broker defaults on a
  cluster that allows auto-creation.

### Changed

- Every request now carries `client.id = topiq/<user>@<host>`, and topiq's ephemeral
  reader groups are `topiq-read-<user>-<random>`, so a broker log or lag dashboard says
  who connected.
- The consumer-group pane describes all groups in one request and reads the topic's
  watermarks once instead of once per group.
- Connection timeout raised from kafkajs's 1 s default to 5 s; request timeout set
  explicitly to 30 s.

### Added

- `TOPIQ_KAFKA_LOG=<path>` appends the Kafka client's debug log to a file, with anything
  token-shaped redacted.

[Unreleased]: https://github.com/candril/topiq/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/candril/topiq/releases/tag/v0.1.0
