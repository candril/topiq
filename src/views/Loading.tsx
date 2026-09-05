import { useEffect, useRef, useState } from "react"
import { theme } from "@/theme.ts"

// Ported from monq's components/Loading.tsx — same braille vocabulary across the family
// (spec 025). Full cell height, so the animation reads at any font size.

// Small spinner: a 3-dot arc rotating clockwise through all 8 braille dots.
const SPINNER_FRAMES = ["⠇", "⡆", "⣄", "⣠", "⢰", "⠸", "⠙", "⠋"]

// Braille dots 1-8 map to bits 0-7; the cell is laid out 1 4 / 2 5 / 3 6 / 7 8.
const BRAILLE_BASE = 0x2800
const BRAILLE_FULL = 0xff
// Clockwise around the perimeter: dot1, dot2, dot3, dot7, dot8, dot6, dot5, dot4.
const DOT_BITS = [0x01, 0x02, 0x04, 0x40, 0x80, 0x20, 0x10, 0x08]
const NUM_DOTS = DOT_BITS.length
const TICK_MS = 120

/** A full braille cell with one dot punched out. */
function brailleWithout(dotIndex: number): string {
  return String.fromCodePoint(BRAILLE_BASE + (BRAILLE_FULL ^ DOT_BITS[dotIndex % NUM_DOTS]!))
}

// Three cells staggered by 3 dots: the hole sweeps left to right.
const COLUMN_OFFSETS = [0, 3, 6]
const WAVE_FRAMES = Array.from({ length: NUM_DOTS }, (_, frame) =>
  COLUMN_OFFSETS.map((offset) => brailleWithout(frame + offset)).join(""),
)

function randomFrame(): string {
  return Array.from({ length: COLUMN_OFFSETS.length }, () =>
    brailleWithout(Math.floor(Math.random() * NUM_DOTS)),
  ).join("")
}

export interface LoadingProps {
  message: string
}

/** Takes the pane: for a wait with nothing to look at yet (connect, first topic list). */
export function Loading({ message }: LoadingProps) {
  const [display, setDisplay] = useState(WAVE_FRAMES[0]!)
  const tick = useRef(0)

  useEffect(() => {
    const timer = setInterval(() => {
      const t = tick.current++
      // One deterministic pass so the shape is legible, then noise — two waits side by
      // side must not look like one repeating clip.
      setDisplay(t < NUM_DOTS ? WAVE_FRAMES[t]! : randomFrame())
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <box
      flexGrow={1}
      flexShrink={1}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <text fg={theme.primary}>{display}</text>
      <box marginTop={1}>
        <text fg={theme.textDim}>{message}</text>
      </box>
    </box>
  )
}

/** Inline: for a wait the rows below already speak for (a message window filling). */
export function Spinner() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  return <text fg={theme.primary}>{SPINNER_FRAMES[frame]}</text>
}
