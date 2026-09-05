# Cluster Groups & Environments

**Status**: In Progress — P1 built (group/env fields, grouped picker, prod colouring in
picker + header, prod/env in every confirm dialog); P2's sibling relation and topic-identity
mapping built for [016](./016-cross-cluster-copy.md); P2 env switch and P3 pending

## Description

A profile is not just a connection — it is one **environment of a logical cluster**.
An org runs the same cluster family in test and prod (`orders-test`/`orders-prod`,
`core-test`/`core-prod`), and topics mirror across them (`test-orders-…` vs
`orders-…`). topiq models that: each profile carries a
`group` (the family) and an `env`, so "this cluster, other environment" is a first-class
relation instead of naming conventions in the user's head.

This layers on [002](./002-cluster-config.md); the profile fields live there.

## Capabilities

### P1 — Must Have

- Profile fields `group` and `env` (free-form strings; `prod`-like envs are declared, not
  guessed — `prod = true` or `env = "prod"` by convention).
- The env is displayed **everywhere the cluster is** — header, confirm dialogs, cluster
  picker ([001](./001-app-shell.md), [019](./019-write-safety.md)). A prod env renders in
  the distinct warning colour; this concretises 019's "environment label".
- The cluster picker groups profiles by `group`, envs as rows underneath — the mental
  model is "Orders → test/prod", not a flat list of hostnames.

### P2 — Should Have

- **Env switch**: a command/chord jumps to the sibling profile (same `group`, other
  `env`), keeping context — same topic modulo `topic_prefix` mapping, same view. The
  "does prod look like test?" move in one keystroke.
- **Built**: cross-cluster copy orders its destinations sibling-first
  ([016](./016-cross-cluster-copy.md)) — the motivating prod → test case — with every prod
  profile last so it is never the default row, and pre-fills the destination topic from the
  two profiles' `topic_prefix`es.
- **Built**: topic-identity mapping is shared logic in `src/config/siblings.ts`:
  `test-dg-foo` (test) ↔ `dg-foo` (prod), derived from each profile's `topic_prefix`. The
  env switch will use the same function.

### P3 — Nice to Have

- Side-by-side lag comparison across envs of a group ([017](./017-consumer-groups.md)).

## Out of Scope

- Env-aware write rules beyond display: `allow_write` stays a per-profile boolean
  ([002](./002-cluster-config.md)); an env never implicitly grants or revokes it.
  Typed-confirmation-for-prod remains [019](./019-write-safety.md) P2.
- Internal/external topic *variants* (`…-external` suffixes) — that is a topic-naming
  convention within a cluster, not a cluster dimension; the topic list's filter handles it
  ([006](./006-topic-list.md)).
- Aggregating multiple clusters into one view. One connection at a time, plus the copy
  path's second connection.

## Technical Notes

- Config stays flat — `[clusters.orders-test]` with `group = "orders"`,
  `env = "test"` — rather than nested `[clusters.orders.test]` tables: profiles keep
  standalone names usable as CLI args (`topiq orders-test`), and a profile without
  `group`/`env` (someone else's single cluster) stays valid with zero ceremony.
- The sibling relation is derived (`same group, different env`), not configured — no
  `sibling = …` key to drift.
- 019's prod colouring keys off the declared env, never off hostname heuristics — the
  a managed cluster's hostname often encodes its environment, but that is vendor trivia,
  not contract.

## Implementation Notes (P2, partial)

- `topic_prefix` is a *namespace*, not necessarily a whole path segment: the config's
  `topic_prefix = "test"` matches `test-orders`. `mapTopicName` therefore strips the
  prefix **and** the separator that followed it, then re-joins with the destination's,
  carrying that separator across; with none to carry (a source with no prefix) it uses `-`,
  the common convention. Two profiles outside that convention get the topic unchanged — a
  guessed rename would be worse than an honest identity, and the name is editable anyway.
- `siblingOf` returns null when there is no *single* answer, which is what makes the third
  env below a real open question rather than a silent wrong pick.

## Open Questions

- **More than two envs per group?** (e.g. a dev cluster.) The model allows it; env
  *switch* then needs a picker instead of a toggle. Decide when a third env actually
  exists.

## File Structure

| File | Change |
|------|--------|
| `src/config/schema.ts` | `group`, `env` fields + prod flag |
| `src/config/siblings.ts` | Sibling resolution + topic-identity mapping + copy destination order |
| `src/views/ClusterPicker.tsx` | Grouped picker |
| `src/views/clusterPickerModel.ts` | Pure row shaping — headers per group, env rows, prod-last order |
| `src/clusterSession.ts` | Profile + client + registry as one runtime unit; `ConnectCluster` seam type |

## Implementation Notes (P1)

- Picker rows: groups sorted by name, envs within a group non-prod first (prod-last keeps
  the dangerous row off the default landing), ungrouped profiles flat after the groups.
- Prod colouring uses `isProd` (declared `prod = true` or `env = "prod"`) in picker rows
  and the header env badge; confirm dialogs come with [019](./019-write-safety.md).
- Selecting a profile runs `password_cmd` and builds client + registry at that point
  (`connectCluster` in `index.tsx`); the previous session is disconnected only once the
  new one is up, and ascending to the picker (esc) keeps the session alive.
