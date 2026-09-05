# NFR: Code Quality, Architecture & Tooling

**Status**: Draft

## Requirement

The codebase stays small, typed and consistent, with a strict separation between the UI and
the Kafka transport, and a `just`-driven workflow — matching
[`monq`](../../../monq) and [`lane`](../../../lane) so the three feel like one family.

## Criteria

- `just check` (typecheck + lint + fmt-check) passes with no errors before work is
  considered done.
- Strict TypeScript, no implicit `any`. `oxlint` clean; `oxfmt` formatting enforced
  (no semicolons, double quotes, trailing commas, 100 cols, 2-space indent).
- The UI depends only on `src/types.ts`, never on a Kafka library — the seam in
  `index.tsx` is the only place a transport is chosen
  ([../003-kafka-client-seam](../003-kafka-client-seam.md),
  [../004-data-model](../004-data-model.md)).
- No god files. A file over ~300 lines is a signal to ask whether it does more than one
  thing. Colocate by domain, not by kind.
- **Dependencies point inward.** `src/safety/`, `src/kafka/`, `src/schema/`, `src/filter/`
  and `src/table/` must not import from `src/views/` — a rule with teeth, because a
  safety module that drags a view in cannot be used outside the UI (`relativeAge` lives in
  `src/time.ts` for exactly this reason).
- Components are presentational; state lives in the root reducer with domain sub-reducers;
  key handling lives in hooks ([../001-app-shell](../001-app-shell.md)).
- Colours come from `theme.ts`; no hex literals in components. Panes are borderless:
  grouping reads as background depth + padding, never border lines (lane/monq).
- Comments explain *why*, not *what*.
- All routine tasks run through the `justfile`.
- Every feature has a spec before implementation, and the spec is updated when the code
  diverges ([../spec-authoring](../spec-authoring.md)).

## Criteria — Version Control

- The project is a **jj (jujutsu)** repository; use `jj`, not `git`.
- Start each task on a fresh change: `jj new -m "…"` **before** editing. Abandon stray
  empty changes rather than leaving them in the log.
- Never force-push. To change something already pushed, stack a new change on top with
  `jj new` — do not rewrite a pushed commit.

## Notes

- Tests: `bun test` via `just test`. The decode/encode and filter layers are pure functions
  over fixtures and are the parts that most need tests — invariant violations
  ([006-data-fidelity](./006-data-fidelity.md)) are exactly what a test catches and a demo
  doesn't.
