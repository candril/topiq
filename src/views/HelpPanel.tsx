import { useTerminalDimensions } from "@opentui/react"
import { theme } from "@/theme.ts"

// Spec 022 P1: bindings grouped by area, on demand only — discoverability costs zero
// permanent rows. Open/dismiss (`?` / esc / q) is handled by App's global keymap.

export type HelpSection = [string, [string, string][]]

const GROUPS: HelpSection[] = [
  [
    "Navigation",
    [
      ["j/k ↑/↓ ^n/^p", "move"],
      ["g/G", "top / bottom"],
      ["^d/^u", "half page down / up"],
      ["h/l ←/→", "column (table) · level (lists)"],
      ["l →", "open cluster / topic"],
      ["h ←", "back one level"],
      ["enter", "open cluster / topic / message"],
      ["esc", "back / close"],
    ],
  ],
  [
    "Topics",
    [
      ["/", "filter topics"],
      ["i", "toggle internal topics"],
      ["s", "cycle sort"],
      ["p", "partition detail"],
      ["J/K", "scroll the partition pane"],
      ["c", "consumer groups for this topic"],
    ],
  ],
  [
    "Groups",
    [
      ["p / enter", "per-partition committed · high · lag"],
      ["m", "members: client id, host, assignment"],
      ["J/K", "scroll the open pane"],
      ["t", "only groups consuming this topic"],
      ["e", "show topiq's own reader groups"],
      ["s", "cycle sort"],
      ["/", "filter by group id"],
      ["r", "refresh state and lag"],
      ["—", "lag is undefined, not zero: nothing committed"],
      ["+?", "total is a floor: some partition uncommitted"],
    ],
  ],
  [
    "Seek offsets",
    [
      ["o", "move this group's committed offsets"],
      ["h/l ←/→", "pick beginning / end / offset / timestamp"],
      ["enter", "resolve the target against the broker"],
      ["shift+S", "confirm the write"],
      ["esc", "cancel"],
      ["—", "the group must be Empty; scaling it stays manual"],
    ],
  ],
  [
    "Fetch",
    [
      ["o", "from offset"],
      ["t", "from timestamp"],
      ["n", "latest N"],
      ["b", "from beginning"],
      ["r", "reload window"],
      ["—", "rows are newest first; g is the live edge"],
      ["s", "sort by selected column"],
      ["c", "choose columns"],
      ["-", "hide the selected column"],
      ["0/$", "first / last column"],
    ],
  ],
  [
    "Follow",
    [
      ["f", "follow the tail"],
      ["space", "pause / resume"],
      ["g", "rejoin the newest row"],
    ],
  ],
  [
    "Filter",
    [
      ["/", "filter the window"],
      ["^y", "accept suggestion / drill in"],
      ["*", "filter by the cell under the cursor"],
      ["=", "JS predicate box (^s apply)"],
      ["enter", "close the bar"],
      ["esc / ⌫", "clear the filter"],
    ],
  ],
  ["Message", [["enter", "view in $EDITOR — l stays navigation"]]],
  [
    "Replay",
    [
      ["p", "replay this message byte-exact"],
      ["e", "edit the value in $EDITOR, then replay"],
      ["shift+R", "confirm — new offset and timestamp"],
      ["esc", "cancel"],
      ["—", "an edit re-encodes: its bytes differ from the original"],
    ],
  ],
  [
    "Craft",
    [
      ["shift+N", "new message from the subject's latest schema"],
      ["shift+P", "confirm the produce"],
      ["esc", "cancel"],
      ["—", "the buffer carries key, value and headers"],
    ],
  ],
  [
    "Copy across clusters",
    [
      ["y", "copy this message to another cluster"],
      ["j/k", "pick the destination · prod never leads"],
      ["enter", "accept, then name the topic there"],
      ["shift+C", "confirm the write"],
      ["esc", "cancel"],
      ["—", "not a byte copy: decoded here, re-encoded there"],
    ],
  ],
  [
    "General",
    [
      ["^p", "command palette — every action, fuzzy-searched"],
      ["?", "help"],
      ["q", "quit"],
    ],
  ],
]

/** Rows a section needs: its title plus its bindings plus the blank line above it. */
function sectionRows(section: HelpSection): number {
  return section[1].length + 2
}

/** Split the sections into columns that each fit the terminal, keeping section order.
 *  Without this the panel is simply taller than the screen and OpenTUI draws its rows on
 *  top of each other — which looks like corrupted text, not like an overflow. */
export function helpColumns(sections: readonly HelpSection[], height: number): HelpSection[][] {
  const budget = Math.max(4, height - 4)
  const columns: HelpSection[][] = [[]]
  let used = 0
  for (const section of sections) {
    const rows = sectionRows(section)
    if (used + rows > budget && columns[columns.length - 1]!.length > 0) {
      columns.push([])
      used = 0
    }
    columns[columns.length - 1]!.push(section)
    used += rows
  }
  return columns
}

export function HelpPanel() {
  const { height } = useTerminalDimensions()
  const columns = helpColumns(GROUPS, height)
  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      zIndex={100}
      // Opaque on purpose: a transparent overlay lets the table bleed through and leaves
      // stale cells behind when it closes, which reads as a corrupted screen.
      backgroundColor={theme.bg}
    >
      <box flexDirection="column" backgroundColor={theme.modalBg} paddingX={3} paddingY={1}>
        <text fg={theme.text}>
          <strong>Help</strong>
        </text>
        <box flexDirection="row" gap={4}>
          {columns.map((column, i) => (
            <box key={i} flexDirection="column">
              {column.map(([area, bindings]) => (
                <box key={area} flexDirection="column" marginTop={1}>
                  <text fg={theme.secondary}>{area}</text>
                  {bindings.map(([key, desc]) => (
                    <box key={key} flexDirection="row">
                      <text fg={theme.primary}>{`  ${key}`.padEnd(12)}</text>
                      <text fg={theme.textDim}>{desc}</text>
                    </box>
                  ))}
                </box>
              ))}
            </box>
          ))}
        </box>
        <box marginTop={1}>
          <text fg={theme.textMuted}>esc · ? · q to close</text>
        </box>
      </box>
    </box>
  )
}
