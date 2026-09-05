# How to Write a topiq Spec

**Status**: Living

This is the spec for writing specs. It keeps `specs/` a record of what topiq is and why —
never a pile of speculative design.

## Philosophy

- **Nothing invented ahead of need.** Every spec traces to something already built or
  already discussed (today: [`PLAN.md`](../PLAN.md)). A spec documents a decision or a
  concrete near-term intent — not a wishlist.
- **Open Questions, not guesses.** Where a design decision is genuinely open — notably
  *which Kafka client* — record it as an **Open Question** rather than inventing an
  answer. Resolve it in place once reality decides.
- **Terse, why-first.** Say what the feature does and *why* it's shaped that way. Prefer
  a sentence with a reason over a paragraph without one.
- **Cross-link generously.** Features interlock; link them so a reader can follow the seams.
- **Invariants outrank features.** The three correctness invariants (BigInt, byte-exact
  replay, cross-cluster re-encode) constrain every spec that touches bytes. When a
  capability brushes one, say which and link [nfr/006](./nfr/006-data-fidelity.md).

## When to write one

Write a feature spec when introducing a user-facing capability or a design decision worth
recording (a data-model change, a new client-seam method, a new view). Small mechanical
changes (a bug fix, a rename, a colour tweak) don't need a spec — the commit is the record.
If a change resolves an existing spec's Open Question, update that spec instead of writing
a new one.

## Naming & numbering

- Feature specs: `NNN-feature-name.md`, numbered **sequentially** (next free number),
  kebab-case. The number is an id, not a priority.
- NFR specs: `nfr/NNN-name.md`, numbered within `nfr/`.
- After creating one, **add a row to [`README.md`](./README.md)'s index** (and the status
  summary). An unindexed spec is easy to lose.

## Structure of a feature spec

```markdown
# Feature Name

**Status**: Draft

## Description
One or two paragraphs: what it does and the motivating use.

## Capabilities
### P1 — Must Have
- The MVP: the smallest set that makes the feature real.
### P2 — Should Have
- Valuable, but the feature stands without it.
### P3 — Nice to Have
- Polish; explicitly optional.

## Out of Scope
- What this deliberately does *not* do, and where that lives instead (link it).

## Technical Notes
- How it fits the code: which module changes, which existing helper to reuse.

## File Structure
| File | Change |
|------|--------|
| `src/…` | … |
```

**Required**: Description, Capabilities, Out of Scope, Technical Notes.
**Add when useful**: `File Structure`, `Open Questions`, `Decisions (as built)`,
`Key Files`, `Keyboard`, `Invariants`.

### Capabilities & priorities

P1 is the line for "the feature exists at all." Each bullet should be a checkable
capability, not a vague aspiration. This keeps a spec implementable in slices and makes
what can be deferred obvious.

### Out of Scope

Name the tempting-but-excluded things and point to where they actually belong. This is
where a spec earns its keep — it stops scope creep and prevents two specs claiming the
same ground.

## Status lifecycle

`Draft` → `Ready` → `In Progress` → `Done`.

- **Draft** — discussed, shape roughed in, not yet ready to build.
- **Ready** — refined enough to implement.
- **In Progress** — being built (`Partial` is fine for "P1 done, P2 pending").
- **Done** / **Implemented** — built and verified.
- **Blocked** — can't proceed; say why in the body and link the blocker.

Keep the `**Status**:` line and the README index in sync.

## Open Questions — record, then resolve

State the question, list options in preference order, and note how it'll be decided
("resolve before implementing", "depends on what the client exposes"). When reality
answers it, **resolve in place**: strike the question and add the answer, e.g.

```markdown
- ~~**Which Kafka client?**~~ **Resolved:** the Confluent binding loads clean under Bun …
```

Don't delete resolved questions — the trail is part of the record.

## Cross-links

Reference other specs as `[NNN](./NNN-name.md)` and NFRs as `[nfr/NNN](./nfr/NNN-name.md)`.
Link the first time you mention a related feature in a section. When a capability depends
on another spec's data or seam, say so and link it.

## NFR specs

Non-functional specs (`nfr/`) use a different skeleton: **Requirement** + **Criteria**
(a checklist of what "safe/fast/lossless" concretely means) + **Notes**.

## Keeping specs honest

A spec is a living document, not a contract signed once. If a spec's premise turns out
wrong (a client can't do what it assumed, a registry API doesn't exist), rewrite the
affected section and flip the status rather than leaving a confident-but-false claim.
