# Cluster Config & Profiles

**Status**: Done — P1+P2 built (load/validate, `password_cmd`, `topic_prefix` filter in
[006](./006-topic-list.md), picker + prod colouring via [023](./023-cluster-groups-and-environments.md));
P3 (`default_cluster`, per-profile defaults) not built

## Description

A lane-style TOML config defining cluster profiles: brokers, registry, SASL identity, a
`password_cmd` to fetch the secret lazily, an optional topic prefix, and the `allow_write`
gate. `config.example.toml` is checked in; the real config is local-only and never
committed.

## Capabilities

### P1 — Must Have

- Load `~/.config/topiq/config.toml` (override via `TOPIQ_CONFIG`); parse
  `[clusters.<name>]` into a typed `ClusterProfile`.
- Fields: `brokers[]`, `registry`, `sasl { mechanism, username }`, `password_cmd`,
  `ca_cert?` (path to a PEM), `topic_prefix?`, `allow_write` (default **false**).
- `sasl.mechanism` accepts `scram-sha-256` and `scram-sha-512` — two cluster families in
  one org routinely disagree on which, so the mechanism is per profile, not a constant.
- `group` and `env` identify the profile as one environment of a logical cluster —
  semantics in [023](./023-cluster-groups-and-environments.md).
- `ca_cert` is required in practice for Aiven clusters: they present a chain rooted in
  the self-signed Aiven project CA, which no default trust store accepts — spike finding
  in [003](./003-kafka-client-seam.md). The CA applies to brokers **and** the registry.
- `password_cmd` is executed on demand, its stdout trimmed and used as the password —
  never stored, logged, or written to disk ([nfr/003](./nfr/003-security-and-credentials.md)).
- Validation with actionable errors: unknown key, missing broker, malformed URL — name the
  file and the offending key, don't stack-trace.
- `config.example.toml` documents every key, with a realistic test/prod profile pair as
  commented examples.

### P2 — Should Have

- `topic_prefix` filters the topic list and prefixes produced topic names, so a test
  cluster's `test-` namespace isn't noise ([006](./006-topic-list.md)).
- Cluster picker UI when no cluster is given, listing profiles with their write status.
- Per-profile display colour/label so prod is visually unmistakable
  ([019](./019-write-safety.md)).

### P3 — Nice to Have

- `default_cluster`.
- Per-profile default topic and fetch mode ([009](./009-paging-and-fetch-modes.md)).

## Out of Scope

- Writing config from the app — the file is hand-edited.
- Credential storage of any kind. topiq holds no secret at rest, by construction.

## Technical Notes

- `password_cmd` runs through a shell (`Bun.$`/`spawn`) because real values are
  `az keyvault …` or `op read …` pipelines. Failure must surface the command's stderr —
  minus anything that looks like a token.
- Aiven's registry uses basic auth with the *same* SASL credentials; the profile carries
  one identity and both clients derive from it ([005](./005-schema-registry.md)).

## Open Questions

- **Does the registry ever need a distinct credential?** Assume no (Aiven shares them);
  add `registry_auth` only if a real cluster forces it.

## File Structure

| File | Change |
|------|--------|
| `config.example.toml` | New, checked in |
| `src/config/schema.ts` | `ClusterProfile` types + validation |
| `src/config/load.ts` | Read/parse TOML |
| `src/config/secret.ts` | `password_cmd` execution (the only secret-touching module) |
