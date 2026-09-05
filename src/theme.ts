// Tokyo Night, same base palette as lane/monq. The one file a colour literal may live
// in (nfr/005) — components import { theme }, never a hex string.

export type Theme = typeof tokyoNight

const tokyoNight = {
  bg: "#1a1b26",
  headerBg: "#24283b",
  panelBg: "#1f2335",
  modalBg: "#16161e",

  text: "#c0caf5",
  textDim: "#565f89",
  textMuted: "#414868",

  primary: "#7aa2f7",

  secondary: "#bb9af7",
  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",

  // No border tokens on purpose: panes are borderless — depth comes from
  // panelBg/modalBg + padding (lane/monq convention, AGENTS.md).
} as const

export const theme: Theme = tokyoNight
