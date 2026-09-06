# Screenshots and the demo gif

Every image in the README and on the docs site comes from the offline demo cluster
(`topiq --demo`, [spec 027](../specs/027-demo-mode.md)), so it can be regenerated on any
machine without a broker, the same picture comes out twice — and nothing from a real
cluster can ever appear in a frame. That last one is the rule, not a convenience: text
can be sanitised after the fact, pixels cannot. **Never point this pipeline at a real
cluster.** If the demo cannot show something, extend the seed.

## The automated way

```sh
just shots              # every recipe in docs/shots.txt → site/src/assets/screenshots/
just shots table help   # only those two
```

Needs `tmux` and `python3` with Pillow (`pip install pillow`). Each shot launches a
fresh `topiq --demo` in a detached 140×42 tmux pane with throwaway XDG dirs, the version
pinned to `0.1.0` and `TOPIQ_DEMO_EPOCH` pinned to the top of the current hour, sends the
recipe's keys, captures the pane with its colours, and renders it in Menlo on the app's
background. The rendered PNGs are what the docs use; the raw captures land in
`$TMPDIR/topiq-shots/` if you want to inspect one.

`SHOT_COLS` / `SHOT_ROWS` change the pane size, `SHOT_DIR` the output directory,
`TOPIQ_DEMO_EPOCH` the timestamp anchor.

## The recipes

`docs/shots.txt` is the playbook: one line per image, `name | keys`. The keys are what
you would press by hand after launching, as tmux `send-keys` tokens — a letter, a
string, `Enter`, `Escape`, `Space`, `C-p`, plus `wait` for a background load. The demo
opens connected to `demo-test` on the topic list, cursor on `customers.updated.v1`;
`j Enter wait` opens `orders.placed.v2`, the main topic.

| Image | Keys | Shows |
| --- | --- | --- |
| `topics` | — | the topic list with watermarks |
| `topics-partitions` | `j p` | the partition pane |
| `topics-internal` | `i` | `__consumer_offsets` shown |
| `topics-filter` | `/ order` | the topic filter |
| `clusters` | `esc` | the cluster picker, grouped by family |
| `prod` | `esc j ↵` | `demo-prod`: env in the warning colour, writes off |
| `table` | `j ↵` | the message table, newest first |
| `columns` | `… c` | the column picker |
| `sort` / `hide` | `… l l l l s` / `… l l -` | sort on a column / hide one |
| `latest-n` / `from-timestamp` | `… n` / `… t` | the range prompts |
| `subtypes` | `j j ↵` | two event types on one topic |
| `decode-failed` | `↵ G` | the `decode failed` row |
| `filter` / `filter-suggest` / `filter-cell` | `… /` … | the filter bar, suggestions, filter-by-cell |
| `js-filter` | `… =` | the JS predicate box |
| `follow` / `follow-paused` | `… f` / `… f space` | the tail, live and paused |
| `replay` / `replayed` | `… p` / `… p ⇧R` | the confirm dialog, and the landed replay |
| `copy` / `copy-confirm` | from `demo-prod`: `… y` / `… y ↵ ↵` | the destination bar, and the two-registry dialog — prod → test, the only direction with a writable target |
| `groups` | `j c` | consumer groups for the topic |
| `group-partitions` / `group-members` | `… p` / `… m` | the panes |
| `seek` / `seek-resolved` / `seek-refused` | `… o` … | the seek bar, a resolved plan, a refusal |
| `palette` | `… ^P` | the command palette |
| `help` | `?` | the keymap |

## By hand

If you'd rather screenshot a real terminal (nicer font, your own theme), `just shot`
opens the same demo with isolated state and the version pinned to `0.1.0`, at whatever
size the window is. Set it to 140×42 cells so the framing matches, follow a recipe from
the table, and save the image under the same name in `site/src/assets/screenshots/`.

## The demo gif

```sh
just demo-gif         # → site/src/assets/topiq-demo.gif
```

Same machinery: `docs/demo.txt` is a list of `hold | keys | keycap | caption` steps,
`scripts/demo.sh` plays them into one `topiq --demo` session, captures a frame after
each, and the renderer assembles the frames into a GIF at half size.

The keycap and caption are drawn on a translucent panel low over the frame — without
them the tour is a table flickering through states nobody can name — so every step says
which keys were pressed and what they did. Give every step a caption: a step without one
drops the panel, and it reads as a glitch.

`hold` is seconds, or `auto` to derive the dwell from the caption's word count. Prefer
`auto`: a caption nobody can finish reading is the same as no caption, and a hand-picked
number goes stale the moment the wording changes. Keep captions short — every word is
dwell time, and a minute is already a long loop for a README.

A step whose keys are only cursor keys (`j k g G`) gets the row under the cursor ringed
in amber, with an arrow from where it was in the previous frame. Fold `Escape` into the
next step's keys rather than spending a frame on it.

The tour must show a **write** — the replay landing — because that is what topiq does
that the consume-only tools do not. Edit the steps to change the tour; it comes out
identical every time.
