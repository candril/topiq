#!/usr/bin/env bash
# Take the documentation screenshots from the demo cluster, unattended (spec 028).
#
#   scripts/shots.sh [name ...]         # all shots in docs/shots.txt, or just the named ones
#
# Each line of docs/shots.txt is `name | keys`, where keys are tmux send-keys tokens
# (Enter, Escape, Space, C-p, or a literal string) sent one at a time; `wait` pauses
# for a background load. Every shot starts from a fresh launch of `topiq --demo` in a
# detached tmux pane with isolated XDG dirs, so the sequence in the file is the whole
# recipe — the same keys you would press by hand. The pane is captured with its colours
# and rendered to a PNG.
#
# Two pins keep frames stable between runs: TOPIQ_VERSION for the header, and
# TOPIQ_DEMO_EPOCH at the top of the current hour so timestamps hold still for a whole
# run and every age reads as minutes, never "in the future" (spec 027).
set -euo pipefail
# No globbing: a recipe key like `*` (filter by cell) must reach tmux as itself, not as
# the files in the working directory.
set -f

cd "$(dirname "$0")/.."

COLS=${SHOT_COLS:-140}
ROWS=${SHOT_ROWS:-42}
OUT=${SHOT_DIR:-site/src/assets/screenshots}
SESSION=topiq-shots
SCRATCH=${TMPDIR:-/tmp}/topiq-shots
EPOCH=${TOPIQ_DEMO_EPOCH:-$(date -u +%Y-%m-%dT%H:00:00Z)}

mkdir -p "$OUT" "$SCRATCH"

launch() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$SCRATCH/xdg"
  tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" \
    "XDG_CACHE_HOME=$SCRATCH/xdg/cache XDG_STATE_HOME=$SCRATCH/xdg/state \
     XDG_CONFIG_HOME=$SCRATCH/xdg/config TOPIQ_DEMO_EPOCH=$EPOCH EDITOR=true \
     bun --define 'TOPIQ_VERSION=\"0.1.0\"' src/index.tsx --demo 2>/dev/null; sleep 300"
  sleep 3
}

shoot() {
  local name=$1; shift
  launch
  for key in "$@"; do
    if [ "$key" = "wait" ]; then
      sleep 2
      continue
    fi
    tmux send-keys -t "$SESSION" -- "$key"
    sleep 0.35
  done
  sleep 1
  tmux capture-pane -t "$SESSION" -e -N -p > "$SCRATCH/$name.txt"
  python3 scripts/render-shot.py "$SCRATCH/$name.txt" "$OUT/$name.png" --cols "$COLS" --rows "$ROWS"
}

wanted=("$@")
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  name=$(echo "${line%%|*}" | xargs)
  keys=$(echo "${line#*|}" | xargs)
  if [ ${#wanted[@]} -gt 0 ] && [[ ! " ${wanted[*]} " == *" $name "* ]]; then
    continue
  fi
  # shellcheck disable=SC2086
  shoot "$name" $keys
done < docs/shots.txt

tmux kill-session -t "$SESSION" 2>/dev/null || true
echo "done → $OUT"
