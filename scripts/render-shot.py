#!/usr/bin/env python3
"""Render tmux `capture-pane -e` dumps to a PNG, or a sequence of them to a GIF.

    python3 scripts/render-shot.py capture.txt out.png [--cols 140] [--rows 42]
    python3 scripts/render-shot.py --gif out.gif --frames frames.tsv

The capture carries the terminal's SGR escapes (truecolor, bold, dim, italic,
underline, strikethrough), which is everything topiq draws with. Pillow renders the
cells in Menlo on the app's own background, so the result is the screenshot a terminal
would show, minus the window chrome — and reproducible, since nothing about it depends
on which terminal or font happens to be installed.

Ported from lane's scripts/render-shot.py (spec 028); the constants near the top are the
only topiq-specific parts. Keep the rest identical so a fix lands in both.
"""

import argparse
import re
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Menlo.ttc"
SIZE = 30  # rendered at 2x and left that way; retina-friendly on the docs site
BG = (26, 27, 38)  # theme.bg
FG = (192, 202, 245)  # theme.text
PAD = 40
# The cell grid: Menlo's advance width is not a fixed fraction of the point size, so
# measure it instead of assuming one — a wrong CW skews every column across the image.
CW = int(round(ImageFont.truetype(FONT, SIZE, index=0).getlength("M")))
LH = int(round(SIZE * 1.2))

ANSI16 = [
    (26, 27, 38), (247, 118, 142), (158, 206, 106), (224, 175, 104),
    (122, 162, 247), (187, 154, 247), (125, 207, 255), (192, 202, 245),
    (65, 72, 104), (247, 118, 142), (158, 206, 106), (224, 175, 104),
    (122, 162, 247), (187, 154, 247), (125, 207, 255), (192, 202, 245),
]


def color256(n):
    if n < 16:
        return ANSI16[n]
    if n < 232:
        n -= 16
        return tuple(0 if v == 0 else 55 + v * 40 for v in (n // 36, (n // 6) % 6, n % 6))
    v = 8 + (n - 232) * 10
    return (v, v, v)


class Style:
    __slots__ = ("fg", "bg", "bold", "dim", "italic", "underline", "strike")

    def __init__(self):
        self.reset()

    def reset(self):
        self.fg, self.bg = None, None
        self.bold = self.dim = self.italic = self.underline = self.strike = False

    def copy(self):
        s = Style()
        s.fg, s.bg = self.fg, self.bg
        s.bold, s.dim, s.italic = self.bold, self.dim, self.italic
        s.underline, s.strike = self.underline, self.strike
        return s

    def apply(self, params):
        codes = [int(p) if p else 0 for p in params.split(";")] if params else [0]
        i = 0
        while i < len(codes):
            c = codes[i]
            if c == 0:
                self.reset()
            elif c == 1:
                self.bold = True
            elif c == 2:
                self.dim = True
            elif c == 3:
                self.italic = True
            elif c == 4:
                self.underline = True
            elif c == 9:
                self.strike = True
            elif c == 22:
                self.bold = self.dim = False
            elif c == 23:
                self.italic = False
            elif c == 24:
                self.underline = False
            elif c == 29:
                self.strike = False
            elif c == 39:
                self.fg = None
            elif c == 49:
                self.bg = None
            elif 30 <= c <= 37:
                self.fg = ANSI16[c - 30]
            elif 90 <= c <= 97:
                self.fg = ANSI16[c - 90 + 8]
            elif 40 <= c <= 47:
                self.bg = ANSI16[c - 40]
            elif 100 <= c <= 107:
                self.bg = ANSI16[c - 100 + 8]
            elif c in (38, 48):
                target = "fg" if c == 38 else "bg"
                if i + 1 < len(codes) and codes[i + 1] == 2 and i + 4 < len(codes):
                    setattr(self, target, tuple(codes[i + 2 : i + 5]))
                    i += 4
                elif i + 1 < len(codes) and codes[i + 1] == 5 and i + 2 < len(codes):
                    setattr(self, target, color256(codes[i + 2]))
                    i += 2
            i += 1


# Block Elements, as fractions of the cell (x0, y0, x1, y1) — or a blend weight for
# the shade characters. Menlo draws these as em-box glyphs a few pixels shorter than the
# line height, so a scrollbar stacked out of them comes out dashed; fill the cell
# geometry instead so runs tile seamlessly.
BLOCK_FILL = {
    "▀": (0, 0, 1, 1 / 2),  # ▀
    "▄": (0, 1 / 2, 1, 1),  # ▄
    "▌": (0, 0, 1 / 2, 1),  # ▌
    "▐": (1 / 2, 0, 1, 1),  # ▐
    "█": (0, 0, 1, 1),  # █
}
for _i in range(1, 8):  # ▁▂▃▄▅▆▇ — eighths filled from the bottom
    BLOCK_FILL[chr(0x2580 + _i)] = (0, 1 - _i / 8, 1, 1)
for _i in range(1, 8):  # ▏▎▍▌▋▊▉ — eighths filled from the left
    BLOCK_FILL[chr(0x2590 - _i)] = (0, 0, _i / 8, 1)
BLOCK_FILL["▔"] = (0, 0, 1, 1 / 8)  # ▔
BLOCK_FILL["▕"] = (7 / 8, 0, 1, 1)  # ▕
BLOCK_FILL["▖"] = (0, 1 / 2, 1 / 2, 1)  # ▖
BLOCK_FILL["▗"] = (1 / 2, 1 / 2, 1, 1)  # ▗
BLOCK_FILL["▘"] = (0, 0, 1 / 2, 1 / 2)  # ▘
BLOCK_FILL["▝"] = (1 / 2, 0, 1, 1 / 2)  # ▝

SHADE_BLEND = {"░": 0.25, "▒": 0.5, "▓": 0.75}


SGR = re.compile(r"\x1b\[([0-9;]*)m")
OTHER_ESC = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b[=>]")


def parse(text, cols, rows):
    """Lines of (char, Style) cells, padded to the pane size."""
    lines = []
    for raw in text.split("\n")[:rows]:
        raw = OTHER_ESC.sub(lambda m: m.group(0) if m.group(0).endswith("m") else "", raw)
        style = Style()
        cells = []
        pos = 0
        for m in SGR.finditer(raw):
            for ch in raw[pos : m.start()]:
                cells.append((ch, style.copy()))
            style.apply(m.group(1))
            pos = m.end()
        for ch in raw[pos:]:
            cells.append((ch, style.copy()))
        cells = cells[:cols]
        cells += [(" ", Style())] * (cols - len(cells))
        lines.append(cells)
    while len(lines) < rows:
        lines.append([(" ", Style())] * cols)
    return lines


def render(lines, out, cols, rows):
    image(lines, cols, rows).save(out, optimize=True)


def image(lines, cols, rows):
    regular = ImageFont.truetype(FONT, SIZE, index=0)
    bold = ImageFont.truetype(FONT, SIZE, index=1)
    italic = ImageFont.truetype(FONT, SIZE, index=2)
    cw, lh = CW, LH
    img = Image.new("RGB", (cols * cw + 2 * PAD, rows * lh + 2 * PAD), BG)
    draw = ImageDraw.Draw(img)
    ascent = regular.getmetrics()[0]
    baseline_pad = (lh - sum(regular.getmetrics())) // 2

    for r, cells in enumerate(lines):
        y = PAD + r * lh
        for c, (ch, st) in enumerate(cells):
            x = PAD + c * cw
            if st.bg:
                draw.rectangle([x, y, x + cw - 1, y + lh - 1], fill=st.bg)
            if ch == " ":
                continue
            fg = st.fg or FG
            if st.dim:
                fg = tuple(int(v * 0.6 + b * 0.4) for v, b in zip(fg, st.bg or BG))
            if ch in BLOCK_FILL:
                fx0, fy0, fx1, fy1 = BLOCK_FILL[ch]
                draw.rectangle(
                    [x + round(fx0 * cw), y + round(fy0 * lh),
                     x + round(fx1 * cw) - 1, y + round(fy1 * lh) - 1],
                    fill=fg,
                )
                continue
            if ch in SHADE_BLEND:
                w = SHADE_BLEND[ch]
                blend = tuple(int(v * w + b * (1 - w)) for v, b in zip(fg, st.bg or BG))
                draw.rectangle([x, y, x + cw - 1, y + lh - 1], fill=blend)
                continue
            font = bold if st.bold else italic if st.italic else regular
            draw.text((x, y + baseline_pad), ch, font=font, fill=fg)
            if st.underline:
                uy = y + baseline_pad + ascent + 2
                draw.line([x, uy, x + cw - 1, uy], fill=fg, width=2)
            if st.strike:
                sy = y + baseline_pad + ascent * 2 // 3
                draw.line([x, sy, x + cw - 1, sy], fill=fg, width=2)
    return img


CAPTION_SIZE = int(SIZE * 1.45)
CAPTION_BG = (12, 12, 19, 232)  # theme.modalBg, a shade darker and near-opaque
CAPTION_KEY = (122, 162, 247)  # theme.primary
CAPTION_TEXT = (224, 230, 250)
CAPTION_Y = 0.80  # panel centre, as a fraction of the frame height


def captioned(img, keycap, text):
    """A translucent panel low over the frame, naming the keys just pressed and what
    they did — without it the demo is a table flickering through states nobody can
    name. Over the table rather than in a strip beneath it, so the caption reads at a
    glance without the eye leaving the frame."""
    key_font = ImageFont.truetype(FONT, CAPTION_SIZE, index=1)
    font = ImageFont.truetype(FONT, CAPTION_SIZE, index=0)
    gap = font.getlength("MM") if keycap and text else 0
    key_w = key_font.getlength(keycap) if keycap else 0
    pad_x, pad_y = CAPTION_SIZE, int(CAPTION_SIZE * 0.7)
    w = key_w + gap + (font.getlength(text) if text else 0) + 2 * pad_x
    h = CAPTION_SIZE + 2 * pad_y
    x0 = (img.width - w) / 2
    y0 = img.height * CAPTION_Y - h / 2

    panel = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(panel)
    draw.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=h / 3, fill=CAPTION_BG)
    x, mid = x0 + pad_x, y0 + h / 2
    if keycap:
        draw.text((x, mid), keycap, font=key_font, fill=CAPTION_KEY, anchor="lm")
    if text:
        draw.text((x + key_w + gap, mid), text, font=font, fill=CAPTION_TEXT, anchor="lm")
    return Image.alpha_composite(img.convert("RGBA"), panel).convert("RGB")


FOCUS_BG = (31, 35, 53)  # theme.panelBg — the row under the cursor
MARK = (224, 175, 104)  # theme.warning, off-hue from anything topiq draws itself


def focus_box(lines):
    """Pixel bounds of the cursor row: the first line painted in theme.panelBg across
    most of its width. topiq highlights whole rows, not cards, so the box is the row —
    the header uses a different colour and never matches."""
    for r, row in enumerate(lines):
        hits = sum(1 for _, st in row if st.bg == FOCUS_BG)
        if hits >= len(row) * 0.5:
            return (PAD, PAD + r * LH, PAD + len(row) * CW, PAD + (r + 1) * LH)
    return None


def mark_move(img, box, prev):
    """Ring the row under the cursor and, when it has just jumped, point at where it
    came from. A cursor move in a dense table is otherwise a jump cut between two
    similar stills: nothing tells the eye which of fifty rows is the one that changed."""
    if box is None:
        return img
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(over)
    draw.rounded_rectangle(box, radius=8, outline=MARK + (255,), width=5)

    if prev is not None:
        (ax, ay), (bx, by) = _centre(prev), _centre(box)
        span = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
        if span > 2 * CW:
            ux, uy = (bx - ax) / span, (by - ay) / span
            sx, sy = _edge(prev, ux, uy, 16)
            ex, ey = _edge(box, -ux, -uy, 20)
            draw.line([sx, sy, ex, ey], fill=MARK + (235,), width=6)
            head = 26
            draw.polygon(
                [(ex + ux * head, ey + uy * head),
                 (ex - uy * head * 0.55, ey + ux * head * 0.55),
                 (ex + uy * head * 0.55, ey - ux * head * 0.55)],
                fill=MARK + (235,),
            )
    return Image.alpha_composite(img.convert("RGBA"), over).convert("RGB")


def _centre(box):
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


def _edge(box, ux, uy, slack):
    """Where the ray leaving the box centre along (ux, uy) crosses its border."""
    cx, cy = _centre(box)
    hw, hh = (box[2] - box[0]) / 2 + slack, (box[3] - box[1]) / 2 + slack
    t = min(hw / abs(ux) if ux else 1e9, hh / abs(uy) if uy else 1e9)
    return cx + ux * t, cy + uy * t


def hold_for(text):
    """Seconds a frame stays up. A caption nobody can finish reading is the same as no
    caption, so the dwell follows the word count rather than a number chosen by hand."""
    return min(8.0, max(3.0, 1.6 + len(text.split()) / 2.4))


def gif(frames, out, cols, rows):
    """frames: (capture path, seconds or "auto", keycap, caption, mark) tuples. Half-size
    and palette-quantised — a full-size truecolor frame sequence would be tens of
    megabytes for a README."""
    images = []
    durations = []
    prev_focus = None
    for path, seconds, keycap, caption, mark in frames:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = parse(f.read(), cols, rows)
        img = image(lines, cols, rows)
        focus = focus_box(lines)
        if mark:
            img = mark_move(img, focus, prev_focus)
        prev_focus = focus
        if keycap or caption:
            img = captioned(img, keycap, caption)
        img = img.resize((img.width // 2, img.height // 2), Image.LANCZOS)
        images.append(img.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
        durations.append(int((hold_for(caption) if seconds == "auto" else float(seconds)) * 1000))
    images[0].save(
        out,
        save_all=True,
        append_images=images[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="*", help="capture.txt out.png")
    ap.add_argument("--gif", metavar="OUT", help="assemble --frames into an animated GIF")
    ap.add_argument("--frames", metavar="TSV", help="path\\tseconds\\tkeycap\\tcaption\\tmark per line")
    ap.add_argument("--cols", type=int, default=140)
    ap.add_argument("--rows", type=int, default=42)
    args = ap.parse_args()
    if args.gif:
        frames = []
        with open(args.frames, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                path, seconds, keycap, caption, mark = line.rstrip("\n").split("\t")
                frames.append((path, seconds, keycap, caption, mark == "1"))
        gif(frames, args.gif, args.cols, args.rows)
        print(args.gif)
        return
    if len(args.inputs) != 2:
        ap.error("need capture.txt and out.png (or --gif with --frames)")
    capture, out = args.inputs
    with open(capture, encoding="utf-8", errors="replace") as f:
        text = f.read()
    render(parse(text, args.cols, args.rows), out, args.cols, args.rows)
    print(out)


if __name__ == "__main__":
    sys.exit(main())
