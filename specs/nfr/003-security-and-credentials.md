# NFR: Security & Credential Handling

**Status**: Draft

## Requirement

topiq authenticates to brokers and registries with real cluster credentials, but holds no
secret at rest. Secrets are fetched on demand by shelling out and live only in memory for
the process lifetime.

## Criteria

- The config file contains **no password** — only a `password_cmd` to obtain one
  (`az keyvault secret show …`, `op read …`, whatever the user runs)
  ([../002-cluster-config](../002-cluster-config.md)).
- The secret is held in memory only, used to build the SASL credential and the registry's
  basic-auth header, and never written to any file (cache, log, state, crash dump).
- The secret is sent **only** to the profile's configured brokers and registry, over TLS
  (SASL_SSL + SCRAM-SHA-256).
- The secret, the `Authorization` header, and the full `password_cmd` output are never
  logged, echoed, shown in a toast, or included in an error message. Client-log surfacing
  ([../001-app-shell](../001-app-shell.md) P3) is redacted at the source.
- `password_cmd` failures surface the command's stderr with anything token-shaped
  stripped — a failed KeyVault call must be diagnosable without leaking a value.
- No secret-bearing file is ever committed: the real `config.toml` is local-only;
  `config.example.toml` carries placeholders. `.gitignore` enforces this.
- The config names vault entries, brokers and usernames but never a secret; it should be
  `0600` anyway, because the set of clusters an operator can reach is itself worth not
  publishing on a shared machine.
- The `$EDITOR` temp file is created **exclusively** (`wx`) under a randomised name: the
  temp directory is world-writable, so a predictable path is a symlink someone else can
  plant, and following one would write a decoded payload wherever they chose.
- The one thing topiq does persist is the **topic listing** — names and partition counts,
  per profile, `0600` under `$XDG_CACHE_HOME/topiq/topics/`
  ([../006-topic-list](../006-topic-list.md)). It is written through a temp file and
  renamed, so a crash cannot leave a half-written listing behind, and it carries no
  credential, no watermark and no payload. It is still the map of a cluster, hence `0600`
  for the same reason the config is.
- Message payloads may contain personal data (customer records). They are never persisted
  to disk — no message cache, no crash dump of a buffer
  ([../000-vision](../000-vision.md) Non-Goals). One narrow exception: the `$EDITOR`
  view/edit flows ([../008-message-detail](../008-message-detail.md),
  [../014-edit-and-replay](../014-edit-and-replay.md)) write a 0600 temp file for the
  editor's lifetime and unlink it the moment the editor exits.

## Notes

- Credential handling is confined to one module (`src/config/secret.ts`); it is the only
  place a secret is read, and the only place to audit.
- The JS filter escape hatch ([../011-js-filter](../011-js-filter.md)) deliberately has no
  sandbox: the code is the user's own, running with their own credentials, on their own
  machine. There is no privilege boundary to defend — this is a considered decision, not
  an oversight.
