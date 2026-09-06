# topiq — agent notes

Terminal UI for Kafka: peek, filter, replay. Sibling of [`monq`](../monq) (MongoDB TUI)
and [`lane`](../lane) (Jira TUI) — same stack, same ethos. Read [`PLAN.md`](./PLAN.md)
for the product rationale and [`specs/`](./specs/) for the feature record.

## Correctness invariants

These are non-negotiable and predate every feature. Violating one is a bug, not a
tradeoff — see [nfr/006](./specs/nfr/006-data-fidelity.md):

1. **int64 → BigInt everywhere.** Never let an Avro `long` touch `Number`.
2. **Unmodified replay is byte-exact.** Re-produce raw bytes; no decode/re-encode.
3. **Cross-cluster replay is never byte-exact.** Schema ids are registry-local; the UI
   must say so rather than silently corrupt a payload.

## Spec-Driven Development

**All features must have a spec before implementation.**

1. **Write the spec first** — `specs/NNN-feature-name.md`, following
   [`specs/spec-authoring.md`](./specs/spec-authoring.md).
2. **Index it** — add a row to [`specs/README.md`](./specs/README.md). An unindexed spec
   gets lost.
3. **Implement by priority** — P1 first, then P2, then P3.
4. **Keep it honest** — when the code diverges from the spec, update the spec. Resolve
   Open Questions in place; don't delete them.

Status flow: `Draft` → `Ready` → `In Progress` → `Done`.

## Version Control (jj)

> **Before starting ANY new task, create a new jj change first.**
> Run `jj new -m "Description of what you're about to do"` BEFORE making any edits.

1. Run `jj status` first
2. If the current change is empty and unnamed, `jj abandon` it before creating a new one
3. Create a new change: `jj new -m "Description of task"`
4. Make edits
5. Run `just check` and fix any issues before moving on

Do not leave stray empty changes. Check `jj log` — there should be no empty unnamed
changes in the history.

### Parallel work = jj workspaces

When several agents (or a workflow wave) build in parallel, do **not** share the single
working copy — concurrent edits pile into one change. Give each worker its own workspace:

1. `jj workspace add ../topiq-w-<task>` — a separate working copy with its own `@`,
   backed by this repo. Do the work there, with its own `jj new -m "…"`.
2. On completion the change is already in the shared repo — no push or merge dance. The
   main session reviews, rebases/squashes if needed, then `jj workspace forget <name>`
   and deletes the directory.
3. If the main session rewrites history under an open workspace, run
   `jj workspace update-stale` there before continuing.

Workspaces are jj-native (the repo is not colocated, so `git worktree` does not apply).

**Never force-push.** Pushing a bookmark whose history was rewritten (after `jj squash`,
`jj rebase`, `jj describe` on an already-pushed change) overwrites the remote. To change
something already pushed, stack a new change on top with `jj new` — do not rewrite it.

## Code Quality

**Run `just check` before finishing any task.** Typecheck + lint + format check. Fix all
errors before considering work done.

| Command | Description |
|---------|-------------|
| `just run` | Run the app |
| `just dev` | Run with hot reload |
| `just test` | Run tests |
| `just check` | Typecheck + lint + fmt-check |
| `just lint-fix` | Lint and auto-fix |
| `just fmt` | Format source files |
| `just build` | Compile the standalone binary into `dist/` |
| `just install-bin` | Build and install it to `~/.local/bin/topiq` |

> Installing uses `install`, not `cp`, on purpose: overwriting the binary in place keeps
> the inode, and macOS then SIGKILLs it because the cached code signature no longer
> matches — exit 137, no output, looks exactly like a hang. The recipe runs `--version`
> afterwards so a broken install fails loudly instead of at your next launch.
| `just smoke <profile> <topic>` | Live consume against a real cluster from your local config |
| `just release <version>` | Check, tag `v<version>`; pushing the tag builds and publishes ([026](./specs/026-release-and-distribution.md)) |
| `just demo` | The offline demo cluster ([027](./specs/027-demo-mode.md)) — no config, no broker |
| `just shots` / `just demo-gif` | Regenerate every docs screenshot / the README gif from the demo ([028](./specs/028-docs-screenshots-and-gif.md), `docs/screenshots.md`) |
| `just site-dev` / `just site-build` | The Astro/Starlight docs site under `site/` |

**Screenshots and the gif come from `--demo` only.** Never point `scripts/shots.sh` or
`scripts/demo.sh` at a real cluster: a real broker name or payload in a PNG cannot be
grepped out later. If the demo cannot show something, extend `src/demo/seed.ts`.

## Publishing

This repo is public. Nothing in it names a real cluster, broker, vault, service account or
topic — every example is a placeholder, and the live smoke test reads its target from the
local config instead ([nfr/003](./specs/nfr/003-security-and-credentials.md),
[026](./specs/026-release-and-distribution.md)). Keep it that way: a hostname pasted into a
spec to make a note concrete is a leak that outlives the note.

## Keep Files Focused

Do not let files grow into catch-alls. Every file should have a single, clear
responsibility.

- **No god files.** Don't pile unrelated logic into a convenient existing file
  (`App.tsx`, `state.ts`, `types.ts`, `index.ts`). If it doesn't belong to the file's
  core purpose, create a new file.
- **Extract when responsibilities diverge.** A component doing state + key bindings +
  fetching + rendering should have the non-rendering parts as hooks or utilities.
- **Colocate by domain, not by kind.** Related code together over one giant `utils.ts`.
- **Watch file length as a signal.** Over ~300 lines deserves a look — not an automatic
  split, but ask whether the file does more than one thing.

## Conventions

- JSX targets OpenTUI intrinsics: `<box>`, `<text>`, `<span fg=...>`, `<scrollbox>`.
  There is no DOM — do not reach for `<div>`.
- Colours come from `src/theme.ts` (`import { theme }`). Don't hardcode hex in components.
- **Borderless panes.** No `border` on boxes — like lane and monq, visual grouping comes
  from background depth (`theme.panelBg`, `theme.modalBg`) plus padding/margins. The
  theme deliberately has no border colour.
- **Input bars live at the bottom.** Filter bars, prompts and any other typed input sit
  below the content, as in presto/lane/monq — the content box grows (`flexGrow`) and the
  bar is the last child. An idle bar renders **nothing**: it carries live state, never a
  permanent keyboard-hint row ([022](./specs/022-help-panel.md) — `?` is the cheat sheet).
- **A modified key is never a letter binding.** The view keymaps switch on `k.name`,
  which is the bare letter for `^p` as much as for `p` — guard the switch with
  `modified(k)` from `src/keys.ts`, or one keystroke fires two handlers (`^p` opened the
  palette *and* a replay dialog). Ctrl combinations a view genuinely wants must be claimed
  before the switch, as `listNav`/`pageNav` do.
- **A full-screen overlay must be opaque** (`backgroundColor={theme.bg}` on the
  absolutely-positioned wrapper) and **must fit the terminal**. A transparent wrapper lets
  the view beneath bleed through and leaves stale cells when it closes; content taller than
  the screen is drawn on top of itself rather than clipped. Both read as corrupted text,
  not as a layout problem — see `helpColumns` in `HelpPanel.tsx`.
- **A scrolling list must reserve rows for anything below it.** `flexShrink` is 0 by
  default here, and even with `flexShrink={1}` a list whose *children* still render N rows
  overflows its shrunk box and silently pushes the bars off the bottom of the screen — the
  overlay looks like it never opened. Subtract the overlay's height from the row count you
  render (see `overlayRows` in `MessageTable.tsx`), and share one row-count helper between
  the overlay and the subtraction so they cannot drift.
- Keyboard input goes through `useKeyboard` from `@opentui/react`. Normalise the raw key
  (lowercase name + implicit-shift detection) — some terminals send `"H"` with the shift
  flag unset instead of shift+`"h"`.
- `oxfmt`: no semicolons, double quotes, trailing commas, 100 col width, 2-space indent.
- Comments explain *why*, not *what*.
- The UI depends only on domain types, never on a Kafka client directly — the client seam
  is the one place a transport is chosen ([003](./specs/003-kafka-client-seam.md)).

## Tech Stack

- **Runtime**: Bun
- **UI**: OpenTUI React (`@opentui/core` + `@opentui/react`), React 19
- **Kafka**: client not yet chosen — see [003](./specs/003-kafka-client-seam.md)
- **Schema registry**: `@kafkajs/confluent-schema-registry` (+ `avsc`)
- **Typecheck**: `tsgo`; **Lint/Format**: oxlint, oxfmt
- **Task runner**: `just`

> The code scaffold does not exist yet — specs come first. `just`-based commands land
> with [001](./specs/001-app-shell.md).
