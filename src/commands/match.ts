import type { Command } from "./types.ts"

// Fuzzy filtering for the palette (spec 021 P1). Pure and renderer-free: what "rp" ought to
// find is a test, not something to eyeball in a terminal.

/** Characters a word can start after — a hit right after one of these is a word start. */
const BOUNDARIES = " -/_.:$"

const CONTIGUOUS_BONUS = 8
const WORD_START_BONUS = 6
const MAX_GAP_PENALTY = 6

/**
 * Subsequence score for `query` in `text`, or null when it does not match at all. Higher is
 * better: contiguous runs and word starts win, distance between hits costs.
 *
 * Spaces in the query are separators, not characters to find, so "rep byte" matches
 * "Replay this message byte-exact" without the words having to be adjacent.
 */
export function fuzzyScore(text: string, query: string): number | null {
  const needle = query.trim().toLowerCase()
  if (needle === "") {
    return 0
  }
  const haystack = text.toLowerCase()
  let score = 0
  let from = 0
  let previous = -2
  for (const char of needle) {
    if (char === " ") {
      continue
    }
    const at = haystack.indexOf(char, from)
    if (at === -1) {
      return null
    }
    if (at === previous + 1) {
      score += CONTIGUOUS_BONUS
    }
    if (at === 0 || BOUNDARIES.includes(haystack[at - 1] ?? "")) {
      score += WORD_START_BONUS
    }
    score -= Math.min(at - from, MAX_GAP_PENALTY)
    previous = at
    from = at + 1
  }
  return score
}

/** The text a query is matched against: the title plus its section, so "replay" finds the
 *  whole Replay group and "topic filter" finds the one in the Topic section. The direct key
 *  is deliberately not in here — single letters would match nearly everything. */
function haystackFor(command: Command): string {
  return `${command.title} ${command.category}`
}

/**
 * Commands that match, best first. Ordering is by score only: the palette regroups them
 * into its fixed sections afterwards, so this ranks *within* a section without reshuffling
 * the sections themselves.
 */
export function matchCommands(commands: readonly Command[], query: string): Command[] {
  return (
    commands
      .map((command, index) => ({ command, index, score: fuzzyScore(haystackFor(command), query) }))
      .filter(
        (scored): scored is { command: Command; index: number; score: number } =>
          scored.score !== null,
      )
      // Ties keep the order the builder produced — the list must not jitter as you type.
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((scored) => scored.command)
  )
}
