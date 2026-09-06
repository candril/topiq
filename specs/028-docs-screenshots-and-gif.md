# Docs Screenshots, Demo Gif & Site

**Status**: In Progress — P1 built: pipeline, 32 screenshots, the gif, the site; P2 not started

## Description

Every image in the README and on the docs site is generated, unattended, from
`topiq --demo` — the same pipeline [`lane`](../../lane) runs, ported as-is: a detached
tmux pane of fixed size, a recipe of keystrokes per image, `tmux capture-pane -e` for the
coloured cells, and a Pillow renderer that draws them in Menlo on the app's own background.
The gif is the same machinery run over one session, one frame per step, with a keycap and
caption panel drawn low over each frame.

Two properties follow from generating rather than screenshotting by hand, and both are the
point:

- **Reproducible.** The same recipe gives the same pixels on any machine with tmux and
  python3. A screenshot that has drifted from the UI is regenerated with one command, not
  re-shot by someone who has to remember the framing.
- **Safe.** The source is the seeded demo cluster ([027](./027-demo-mode.md)). Nothing a
  real cluster contains can appear in a frame, which is the only acceptable standard for a
  public repo — text can be sanitised after the fact, pixels cannot.

The site is Astro + Starlight on GitHub Pages, as `lane` and `monq` have.

## Capabilities

### P1 — Must Have

- **`scripts/render-shot.py`**, ported from lane. Parses the SGR-coloured capture, renders
  cells in Menlo (regular/bold/italic faces) at a fixed cell size, and handles the block
  and shade glyphs whose em-boxes Menlo draws short. Also assembles a frame manifest into a
  GIF at half size, with the caption panel and the move-marker. Adaptations: topiq's
  background colour from `src/theme.ts`, and the move-marker keys are topiq's
  (`j k h l g G` — the row cursor, not lane's card moves).
- **`scripts/shots.sh`** — one PNG per line of `docs/shots.txt` (`name | keys`), each from
  a fresh `topiq --demo` in a detached 140×42 tmux pane with `TOPIQ_DEMO_EPOCH` pinned and
  `TOPIQ_VERSION` defined to a fixed value, so neither the clock nor the build stamp leaks
  into a frame. Writes to `site/src/assets/screenshots/`.
- **`scripts/demo.sh`** — one session, one frame per line of `docs/demo.txt`
  (`hold | keys | keycap | caption`), assembled into `site/src/assets/topiq-demo.gif`.
  `hold` is seconds or `auto` (dwell from the caption's word count); a step with no keys
  holds the previous frame.
- **`docs/shots.txt`** and **`docs/demo.txt`** — the recipes. The tour in `demo.txt` must
  show a **write**: replay a message, see it land in the tail. That is what topiq does that
  the consume-only tools do not, and a gif that stops at peeking sells the wrong product.
- **`docs/screenshots.md`** — the how-to, including the recipe table. A pipeline nobody can
  find is a pipeline that gets bypassed with a hand screenshot of a real cluster.
- **`just shot`**, **`just shots [names]`**, **`just demo-gif`** — the recipes, matching
  lane's names so the muscle memory transfers.
- **`site/`** — Astro + Starlight: a splash `index.mdx`, a guide (installation, getting
  started) and a reference page per area (key bindings, peek & filter, replay, groups,
  configuration, CLI), screenshots and the gif from `src/assets/`, `logo` in `public/`. **`.github/workflows/deploy-site.yml`** deploys to
  GitHub Pages on a push that touches `site/**`.
- **`README.md`** embeds the gif and links the site.

### P2 — Should Have

- ~~A **feature page per area** on the site.~~ Built in P1: six reference pages.
- **A CI job that regenerates the shots** and fails if any PNG differs from the committed
  one. Drift becomes a red check instead of a stale image. Needs a Linux Menlo substitute
  or a committed font, so this is real work, not a `run:` line.

### P3 — Nice to Have

- An asciinema/`.cast` alongside the gif, for a site that can play it.
- Dark/light theme pairs, if the site ever gets a theme toggle.

## Out of Scope

- **Recording against a real cluster.** Never. If the demo seed cannot show something,
  extend the seed ([027](./027-demo-mode.md)) — do not point the pipeline at a broker.
- **Windows / Linux capture.** The renderer assumes Menlo at a macOS path. A Linux run needs
  a font swap; noted under P2, not promised.
- **The release pipeline** — [026](./026-release-and-distribution.md). This spec produces
  images; 026 produces binaries.

## Technical Notes

- `scripts/render-shot.py` is a straight port — the only lane-specific parts are the
  background colour, the font path, the move-key set and the focus-box heuristic, all
  constants near the top. Keep the diff to lane's copy small so a fix lands in both.
- `tmux send-keys` tokens: a bare letter, a literal string, `Enter`, `Escape`, `Space`,
  `C-p`, plus `wait` for a background load (the demo's fixed latency is what makes the
  wait predictable — [027](./027-demo-mode.md) P2).
- The demo session gets throwaway `XDG_*` dirs so nothing on the machine leaks into a
  frame; topiq has no on-disk state today ([nfr/003](./nfr/003-security-and-credentials.md)),
  but the isolation costs nothing and stays true if that changes.
- `TOPIQ_DEMO_EPOCH` and `--define 'TOPIQ_VERSION="0.1.0"'` are the two pins. Without
  them the header's version and every timestamp differ between runs and the P2 drift check
  can never pass.
- The site is a separate package under `site/` with its own lockfile, as in lane and monq
  — it must not drag Astro into the app's `bun.lock`.

## File Structure

| File | Change |
|------|--------|
| `scripts/render-shot.py` | New — ported from lane; capture → PNG, manifest → GIF |
| `scripts/shots.sh` | New — one `topiq --demo` per recipe line → PNG |
| `scripts/demo.sh` | New — one session, one frame per step → GIF |
| `docs/shots.txt` | New — `name \| keys` per screenshot |
| `docs/demo.txt` | New — `hold \| keys \| keycap \| caption` per gif frame |
| `docs/screenshots.md` | New — the how-to and the recipe table |
| `justfile` | `shot`, `shots`, `demo-gif`, `site-dev`, `site-build` |
| `site/**` | New — Astro + Starlight |
| `.github/workflows/deploy-site.yml` | New — Pages deploy on `site/**` changes |
| `README.md` | Embed the gif, link the site |
| `.gitignore` | `site/dist`, `site/.astro`, `site/node_modules` |

## Open Questions

- ~~**Half-size gif or full?**~~ **Resolved:** half size, as lane. The table's 30px cells
  render at 15px in the gif, which is still legible on a README; full size would be tens
  of megabytes.
- **How long is the tour?** lane's is 14 steps and already "a long loop for a README".
  topiq has more to show (peek → filter → replay → tail → groups). Either one longer gif,
  or a short README gif plus per-page gifs on the site. Resolve after the first cut.
