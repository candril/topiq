# Specs

Feature specifications and non-functional requirements (NFRs) for **topiq**.

Nothing here is invented ahead of need: every spec traces to something in
[`PLAN.md`](../PLAN.md) or already discussed. Where a design decision is genuinely open —
notably *which Kafka client* — it is recorded as an **Open Question** inside the spec
rather than guessed.

Three correctness invariants constrain everything that touches bytes: BigInt-safe
decoding, byte-exact same-cluster replay, and never pretending a cross-cluster copy is one.
They live in [nfr/006](./nfr/006-data-fidelity.md) and are referenced from the specs they
bind.

## Format

Each feature spec follows a consistent structure:

- **Status**: `Draft` | `Ready` | `In Progress` | `Done`
- **Description**: what this feature does
- **Capabilities**: prioritised (P1 = MVP, P2 = Should have, P3 = Nice to have)
- **Out of Scope**: what it explicitly does not do
- **Technical Notes** / **File Structure**: implementation detail

NFR specs (in `nfr/`) use **Requirement** + **Criteria** + **Notes** instead.

See [spec-authoring.md](./spec-authoring.md) for the full conventions — structure, status
lifecycle, prioritisation, Open Questions, and cross-linking.

## Naming

- Feature specs: `NNN-feature-name.md`, numbered sequentially.
- NFR specs: `nfr/NNN-name.md`.

## Workflow

1. Create as `Draft`
2. Refine → `Ready`
3. Implement → `In Progress`
4. Complete and verified → `Done`

## Feature Specs

| # | Name | Status | Description |
|---|------|--------|-------------|
| 000 | [Vision](./000-vision.md) | Draft | Product vision: peek, filter, replay — Kafka from the terminal |
| 001 | [App Shell](./001-app-shell.md) | Done | Renderer, arg parsing, layout, theme, clean startup/shutdown |
| 002 | [Cluster Config & Profiles](./002-cluster-config.md) | Done | TOML cluster profiles; `password_cmd` secrets; `allow_write` gate |
| 003 | [Kafka Client Seam](./003-kafka-client-seam.md) | In Progress | The `KafkaClient` interface — and which library backs it (milestone 1) |
| 004 | [Data Model](./004-data-model.md) | Done | `RawMessage` / `DecodedMessage` / topic + group metadata; raw bytes retained |
| 005 | [Schema Registry & Avro](./005-schema-registry.md) | In Progress | Confluent wire format, per-instance registry cache, `long` → BigInt, encode used by every produce path |
| 006 | [Topic List](./006-topic-list.md) | Done | Topics with partitions, approximate counts measured for the rows on screen, cached between runs; scrollable partition pane |
| 007 | [Message Table](./007-message-table.md) | In Progress | Smart columns inferred from decoded values; lossless rendering |
| 008 | [Message `$EDITOR` View](./008-message-detail.md) | Done | `Enter` opens the message in `$EDITOR` — metadata comments + lossless JSON; no in-app pane |
| 009 | [Paging & Fetch Modes](./009-paging-and-fetch-modes.md) | In Progress | From offset / timestamp / latest-N (watermark math) / follow |
| 010 | [Filter Bar](./010-filter-bar.md) | In Progress | monq-style grammar over the loaded window; autocomplete not built |
| 011 | [JS Filter Escape Hatch](./011-js-filter.md) | In Progress | `(msg) => …` predicates behind `=`, local, no sandbox needed |
| 012 | [Live Tail & Bounded Buffer](./012-live-tail.md) | In Progress | Follow the topic with backpressure and a visible row cap |
| 013 | [Byte-Exact Replay](./013-byte-exact-replay.md) | Done | Re-produce raw bytes to the same topic (invariant 2) |
| 014 | [Edit-and-Replay](./014-edit-and-replay.md) | In Progress | Decode → `$EDITOR` → validate → encode → produce |
| 015 | [Craft Message from Schema](./015-craft-message.md) | In Progress | New message from the topic's latest schema as a template |
| 016 | [Cross-Cluster Copy](./016-cross-cluster-copy.md) | In Progress | prod → test: decode + re-encode against the destination registry (invariant 3); the prod-destination guardrail is ordering + warning, not a refusal |
| 017 | [Consumer Groups & Lag](./017-consumer-groups.md) | In Progress | Group state, members, per-partition lag; undefined lag is `—`, never 0; topiq's own reader groups hidden |
| 018 | [Consumer Group Offset Seek](./018-consumer-group-offset-seek.md) | In Progress | Seek to offset / timestamp / beginning / end; requires an empty group |
| 019 | [Write Safety](./019-write-safety.md) | In Progress | One gate for every mutation: `allow_write` + confirm naming cluster, topic, age |
| 020 | [Keyboard Navigation](./020-keyboard-navigation.md) | In Progress | vim-style keys shared with monq/lane; key normalisation |
| 021 | [Command Palette](./021-command-palette.md) | In Progress | `Ctrl+P` fuzzy, state-aware command list; teaches direct keys; a gated write is listed with its reason |
| 022 | [Help Panel](./022-help-panel.md) | In Progress | `?` overlay of bindings; no persistent status bar |
| 023 | [Cluster Groups & Environments](./023-cluster-groups-and-environments.md) | In Progress | Profiles as group × env (orders/core × test/prod); env switch; copy targets the sibling |
| 024 | [Table Column Navigation](./024-table-column-navigation.md) | In Progress | Column cursor (`h`/`l`), sort on the selected column, hide/display modes, filter-by-cell |
| 025 | [Loading Indicators](./025-loading-indicators.md) | In Progress | Full-pane spinner + rotating flavour for connect and topic list; inline spinner only for a message window |
| 026 | [Release & Distribution](./026-release-and-distribution.md) | In Progress | `v*` tag → per-platform binaries + `SHA256SUMS` → GitHub Release; `curl \| bash` installer; brew tap and flake on top |

## NFR Specs

| # | Name | Status | Requirement |
|---|------|--------|-------------|
| 001 | [Performance](./nfr/001-performance.md) | Draft | Instant local interaction; no blocking I/O on the input path |
| 002 | [Terminal Compatibility](./nfr/002-terminal-compatibility.md) | Draft | Correct rendering & input across common terminals; payloads can't corrupt the layout |
| 003 | [Security & Credentials](./nfr/003-security-and-credentials.md) | Draft | No secret at rest; `password_cmd` only, in memory, never logged |
| 004 | [Reliability & Errors](./nfr/004-reliability-and-errors.md) | Draft | Failures visible, explained, recoverable; nothing silent on a write path |
| 005 | [Code Quality & Architecture](./nfr/005-code-quality-and-architecture.md) | Draft | Strict TS, UI/transport separation, `just`, jj repo |
| 006 | [Data Fidelity](./nfr/006-data-fidelity.md) | Draft | The three invariants: BigInt everywhere, byte-exact replay, honest cross-cluster copy |

## Status Summary

- **Done**: [001](./001-app-shell.md) (P3 debug pane optional, not built), [008](./008-message-detail.md) ($EDITOR view).
  [002](./002-cluster-config.md) (P3 defaults not built),
  [004](./004-data-model.md) (domain types),
  [006](./006-topic-list.md) (P3 registry markers not built).
- **In Progress**: [003](./003-kafka-client-seam.md) (kafkajs seam built — the full
  `KafkaClient` incl. produce, groups, `resolveOffsets` and offset-seek; lifecycle states +
  mock pending),
  [005](./005-schema-registry.md) (own registry client + BigInt-safe decode *and* encode,
  tested and now called by 014/015/016; P2 subject/version in the detail pane pending),
  [007](./007-message-table.md) (P1 built; P2 column controls/sort
  pending),
  [009](./009-paging-and-fetch-modes.md) (P1 incl. UI built; P2 follow built via
  [012](./012-live-tail.md), paging/partition scoping pending),
  [010](./010-filter-bar.md) (P1 + live-stream filtering built; field-name autocomplete,
  session history and saved filters pending),
  [011](./011-js-filter.md) (P1 built behind the `=` prefix; `$EDITOR` editing and
  predicate history pending, P3 timeout guard deliberately not built),
  [012](./012-live-tail.md) (P1 + backpressure built, but the cap is a constant and
  paused drops go unannounced until resume; throughput indicator and
  new-row highlighting pending), [020](./020-keyboard-navigation.md) (P1 complete incl.
  `h`/`l`, plus P2's `?` panel and the `^p` palette chord; the mode chords are the remaining
  P2 work), [021](./021-command-palette.md) (P1 built; P2 submenus and P3 pending),
  [022](./022-help-panel.md) (P1 built; P2 context-awareness pending),
  [023](./023-cluster-groups-and-environments.md) (P1 built; P2 env switch pending),
  [024](./024-table-column-navigation.md) (column cursor + type-aware sort + column picker
  built).
- **Milestone 1 (spike): passed** — kafkajs chosen (Confluent native client crashes Bun
  on import); BigInt keys/values verified live; Aiven project CA pinning required.
  `just smoke` re-runs it through the seam.
- **Milestone 2 (Peek): built** — picker → topic list → table → detail all P1-complete;
  verified by unit tests + live smoke of the seam, not yet by a live TUI session. The
  gate's two leftovers are closed: `h`/`l` are bound ([020](./020-keyboard-navigation.md))
  and the partition pane scrolls ([006](./006-topic-list.md)).
- **Milestone 3 (Filter): built** — the grammar tier ([010](./010-filter-bar.md)), the JS
  escape hatch ([011](./011-js-filter.md)) and live tail ([012](./012-live-tail.md)) are
  P1-complete and wired into the message table, verified by unit tests and a clean
  `just check` / `just smoke`. Not verified by a live TUI session: there is no OpenTUI
  render harness, so every `useKeyboard` block and every hook effect — including the
  follow consumer — is untested code. Carried gaps: no autocomplete (010 P2), no filter
  or predicate history, no `$EDITOR` predicate editing (011 P2), no timeout guard
  (011 P3, by decision), no throughput indicator (012 P2), and the tail cap is a constant.
- **Milestone 5 (Groups): started** — [017](./017-consumer-groups.md) P1 + P2 are built:
  `c` on a topic row opens the group list (state, members, total lag), `p`/`m` open the
  per-partition and member panes, `t`/`e`/`s`/`/`/`r` scope and refresh it. Read-only —
  the view calls nothing that mutates. Undefined lag renders `—` and a partial total `+?`;
  topiq's own `topiq-read-*` reader groups are hidden behind `e`. Verified by unit tests
  over the pure lag/row model and the reducer; the view itself has no render harness.
  P3 (lag trend) not started. [018](./018-consumer-group-offset-seek.md) P1 is built on top
  of it: `o` opens the seek bar, the plan is resolved against the broker (group state,
  committed offsets, target per partition), a non-`Empty` group is refused with its state
  instead of a broker error, and `shift+S` writes behind `evaluateWrite`/`commitWrite` and
  reports the committed offsets read back. Tested against a fake client only — nothing in
  the suite can reach a broker. P2 (single-partition seek, lag delta) and P3 not started.
  [021](./021-command-palette.md) P1 closes the milestone: `^p` opens a fuzzy, state-aware
  overlay over the seven fixed sections, each row showing its direct key. The base views hand
  `^p` over (`listNav`'s `ctrlPrev: false`) while an open list, field or dialog keeps it as
  "previous". A write the gate blocks stays listed, dimmed, with the gate's reason — and the
  palette runs the same closures the direct keys do, so no write path has a second
  implementation. P2's submenus and P3 are not built.
- **Milestone 4 (Replay): built (P1)** — [019](./019-write-safety.md) P1 is the gate module +
  shared confirm dialog, and two write paths now go through it:
  [013](./013-byte-exact-replay.md) P1 (`p`, raw bytes back to the same topic) and
  [014](./014-edit-and-replay.md) P1 (`e`, decode → `$EDITOR` → validate against the
  message's own schema id → re-encode). Both stop at the confirm dialog; neither can produce
  without `allow_write` and a `shift+R`. Offset seek
  ([018](./018-consumer-group-offset-seek.md) P1) is the third, and the only one that is not
  a produce: it moves a group's committed offsets behind the same gate.
  [015](./015-craft-message.md) P1 is the fourth: `shift+N` builds a skeleton from the
  subject's *latest* schema (BigInt placeholders for every `long`, one sample entry per
  array/map, union branches listed in the header), edits it as a `key`/`value`/`headers`
  envelope and produces on `shift+P`. Its P2 (seed from the focused message, remember the
  last body per topic) is not built.
  [016](./016-cross-cluster-copy.md) P1 is the fifth and last produce path, and the only
  one that cannot be byte-exact: `y` opens a destination bar (siblings first, prod never the
  default row), the topic is prefix-mapped and editable, the payload is decoded against the
  source registry and re-encoded against the destination's — two registry objects, two schema
  caches — and the dialog names both clusters, both subjects, both versions and both ids
  before `shift+C` writes. A destination subject that is missing, or that rejects the
  message, aborts; nothing anywhere falls back to producing the source bytes. Its P2 (batch
  copy, dry run) and P3 (JS field rewriting) are not built, and **its fifth P1 bullet is not
  either**: a prod destination is sorted last and warned about, not refused.
- **What no milestone-4/5 claim rests on**: not one byte has been produced and not one offset
  moved. `allow_write` is `false` on both profiles in `~/.config/topiq/config.toml`, no test
  in the suite can open a socket, and `just smoke` is a read-only consume. Every write path is
  verified by construction and by unit tests against fakes — never end to end. There is still
  no OpenTUI render harness, so every `useKeyboard` block, including the four confirm-dialog
  keymaps, is untested code.
- **Release** ([026](./026-release-and-distribution.md)): P1 built — CI on every push, a
  `v*` tag builds four binaries on native runners and publishes them gzipped with
  `SHA256SUMS`, and `scripts/install.sh` fetches and verifies one. Unexercised until the
  first tag is actually pushed: no release has been cut, so the installer's happy path is
  reasoned about, not observed. P2 (Homebrew tap, flake) not started.
- **Draft**: everything else.
- **Next**: a live TUI session against the test cluster with `allow_write = true` — the only
  thing that can turn "built" into "verified" for milestones 4 and 5. Then
  [016](./016-cross-cluster-copy.md)'s prod-destination refusal and its P2 (copy a filtered
  selection, dry run), and [023](./023-cluster-groups-and-environments.md) P2's env switch,
  which now has the sibling and topic-mapping helpers it needs.

## Milestones

Per [`PLAN.md`](../PLAN.md), with the specs each pulls in:

1. **Spike** — [003](./003-kafka-client-seam.md), [005](./005-schema-registry.md)
2. **Peek** — [001](./001-app-shell.md), [002](./002-cluster-config.md),
   [004](./004-data-model.md), [006](./006-topic-list.md), [007](./007-message-table.md),
   [008](./008-message-detail.md), [009](./009-paging-and-fetch-modes.md),
   [020](./020-keyboard-navigation.md), [022](./022-help-panel.md),
   [023](./023-cluster-groups-and-environments.md) (P1)
3. **Filter** — [010](./010-filter-bar.md), [011](./011-js-filter.md),
   [012](./012-live-tail.md)
4. **Replay** — [019](./019-write-safety.md), [013](./013-byte-exact-replay.md),
   [014](./014-edit-and-replay.md), [015](./015-craft-message.md)
5. **Groups** — [017](./017-consumer-groups.md),
   [018](./018-consumer-group-offset-seek.md), then
   [021](./021-command-palette.md) — the palette lands once the commands it lists exist
6. **Cross-cluster copy** — [016](./016-cross-cluster-copy.md) (needs invariant 3 machinery)

Milestone 6 was pulled forward into milestone 4: [016](./016-cross-cluster-copy.md) P1 landed
with the other produce paths, once [013](./013-byte-exact-replay.md)–[015](./015-craft-message.md)
had built the decode/encode/produce/confirm machinery it depends on.
