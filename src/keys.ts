// Structural key shape rather than OpenTUI's KeyEvent so pure key logic stays testable
// under `bun test` without a renderer.
export interface RawKey {
  name?: string
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
}

export interface NormalizedKey {
  name: string
  shift: boolean
  ctrl: boolean
  meta: boolean
}

/**
 * Some terminals send an uppercase name (e.g. "H") with the shift flag unset instead of
 * shift+"h" — fold both shapes into lowercase name + shift so keymaps match either.
 */
export function normalizeKey(key: RawKey): NormalizedKey {
  const raw = key.name ?? ""
  const name = raw.toLowerCase()
  const implicitShift = raw.length === 1 && raw !== name && !key.shift
  return {
    name,
    shift: !!key.shift || implicitShift,
    ctrl: !!key.ctrl,
    meta: !!key.meta,
  }
}

/**
 * Menu/list navigation synonyms (spec 020): arrows, vim j/k, and emacs ctrl-n/ctrl-p.
 * Pass letters: false in text-input contexts so plain j/k keep typing while ^n/^p
 * (and arrows) still move the highlight.
 *
 * `^p` is also the command-palette chord (spec 021). A *base* view — one with no list,
 * menu or text field open on top of it — passes `ctrlPrev: false`, because both handlers
 * see the same key event: without it the palette would open and the cursor underneath it
 * would move in the same keystroke. Inside an open list or a text field the palette stands
 * down instead, and `^p` keeps meaning "previous" there.
 */
export function listNav(
  k: NormalizedKey,
  opts: { letters?: boolean; ctrlPrev?: boolean } = {},
): "next" | "prev" | null {
  const letters = opts.letters ?? true
  if (k.ctrl) {
    if (k.name === "n") {
      return "next"
    }
    if (k.name === "p") {
      return (opts.ctrlPrev ?? true) ? "prev" : null
    }
    return null
  }
  if (k.name === "down" || (letters && k.name === "j")) {
    return "next"
  }
  if (k.name === "up" || (letters && k.name === "k")) {
    return "prev"
  }
  return null
}

/**
 * Hierarchy movement (spec 020): `l`/→ descends a level, `h`/← ascends one.
 *
 * `enter` and `esc` stay out of this helper on purpose. Both carry view-local meanings
 * (act on the row, dismiss a filter or a pane) that a pure navigation key must not
 * inherit — h ascends whether or not a filter is set, where esc clears the filter first.
 *
 * Any modifier declines: ctrl+h is backspace on many terminals (nfr/002), and shift+h/l
 * is left free for view-local uses.
 * Pass letters: false in text-input contexts so h/l keep typing while the arrows move.
 */
export function levelNav(
  k: NormalizedKey,
  opts: { letters?: boolean } = {},
): "descend" | "ascend" | null {
  if (k.ctrl || k.meta || k.shift) {
    return null
  }
  const letters = opts.letters ?? true
  if (k.name === "right" || (letters && k.name === "l")) {
    return "descend"
  }
  if (k.name === "left" || (letters && k.name === "h")) {
    return "ascend"
  }
  return null
}

/**
 * Half-page movement (spec 020): `^d`/`^u`, vim's and monq's binding. Half a screen, not a
 * whole one, so a row you were reading is still on screen after the jump — that overlap is
 * the point of the half page.
 *
 * Only ever consulted outside text input: inside the filter bar and the JS box `^u` is
 * readline's kill-line and belongs to the widget.
 */
export function pageNav(k: NormalizedKey): "down" | "up" | null {
  if (!k.ctrl || k.shift || k.meta) {
    return null
  }
  if (k.name === "d") {
    return "down"
  }
  if (k.name === "u") {
    return "up"
  }
  return null
}

/** Rows a half-page jump moves, given the visible list height. At least one, so a tiny
 *  pane still moves. */
export function halfPage(listHeight: number): number {
  return Math.max(1, Math.floor(listHeight / 2))
}

/**
 * A modified key never means a plain letter binding.
 *
 * The view keymaps switch on `k.name`, which is the bare letter for `^p` as much as for
 * `p` — so without this guard one keystroke fires two handlers: App opens the command
 * palette on `^p` while the message table opens a *replay dialog* on the same event. The
 * ctrl combinations the views do want (`^n`/`^p`, `^d`/`^u`, `^y`, `^s`) are claimed by
 * listNav/pageNav or by an explicit check before the switch is reached.
 */
export function modified(k: NormalizedKey): boolean {
  return k.ctrl || k.meta
}
