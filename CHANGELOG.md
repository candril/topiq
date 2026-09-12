# Changelog

All notable changes to topiq are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the release workflow lifts
the section matching a tag into that release's notes — an unwritten entry ships an empty
release, so write it before tagging.

## [Unreleased]

### Changed

- **OpenTUI 0.1.87 to 0.5.11**, the terminal renderer everything is drawn with, together with
  `@opentui/react` and React 19.3. The one API break was the renderer's console option; screenshots
  taken before and after are pixel-identical, so nothing about the rendering changed.
- Docs site to Astro 7 and Starlight 0.42, two majors.
- oxlint 1.82, oxfmt 0.67, `@types/bun` 1.4.2 and `undici-types` 8.10.2.
- GitHub Actions moved to the Node 24 majors ahead of Node 20 being removed from hosted runners on
  23 September 2026.

## [0.2.0] - 2026-09-09

### Added

- Scan mode: `shift+S` streams the whole range through the filter and keeps only the hits,
  so a topic can be searched past the 10,000-row window. Latest-N scans from the beginning;
  offset and timestamp ranges scan from where they start. The header shows progress against
  the watermarks, throughput, and how the scan ended — end, stopped, capped at 10,000 hits,
  or failed. `shift+S` again stops a running scan or re-runs a finished one; `esc` returns to
  the window and keeps the filter.
- The client seam's consume callback may return a promise; the kafkajs client then waits
  before fetching more, so a scan applies backpressure instead of dropping rows.

## [0.1.1] - 2026-09-06

### Added

- Homebrew (`brew install candril/tap/topiq`) and Nix (`nix run github:candril/topiq`) via
  [candril/homebrew-tap](https://github.com/candril/homebrew-tap), alongside the curl installer.
  All three install the release binary, verified against `SHA256SUMS`.
- The installer, build script and release workflow shared with the sibling tools; a released
  binary reports its tag, and the release writes `release.json` for the Nix flake.

### Changed

- The README and docs site carry the shared spec-driven notice, the same install section as
  the sibling tools, and a footer linking them.

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

[Unreleased]: https://github.com/candril/topiq/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/candril/topiq/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/candril/topiq/releases/tag/v0.1.0
