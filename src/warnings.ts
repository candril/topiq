// Runtime warnings, kept off the alternate screen (nfr/002).
//
// Node and Bun print process warnings to stderr through a listener the runtime installs at
// startup. Once the renderer owns the terminal that write lands in the middle of a frame:
// the renderer repaints only the cells it believes changed, so the text stays there and no
// keystroke repairs it — a row splices mid-cell and everything below drifts out of column.
//
// The warning that made this concrete comes from kafkajs 2.2.4, whose request queue starts
// `throttledUntil` at -1 and then schedules its next check at `throttledUntil - Date.now()`.
// With nothing pending that negative value reaches setTimeout, and the runtime clamps it to
// 1ms and warns. It is harmless in itself and fires on the first broker response of every
// session, which is exactly why it cannot be allowed to reach the screen.
//
// This is not the library's bug to fix from here, and the next dependency's deprecation
// notice would arrive the same way, so the guard is at the process level rather than around
// any one caller.

export type WarningEntry = Record<string, unknown>

/**
 * Take the `warning` event away from the runtime's printing listener and hand it to `log`.
 *
 * Returns a restore function that puts the previous listeners back — the renderer owns the
 * screen for the life of the process, so nothing calls it but the tests.
 */
export function captureWarnings(log: (entry: WarningEntry) => void): () => void {
  const previous = process.listeners("warning")
  process.removeAllListeners("warning")

  const listener = (warning: Error): void => {
    try {
      log({
        level: "WARN",
        namespace: "process",
        message: warning.message,
        name: warning.name,
        stack: warning.stack,
      })
    } catch {
      // A sink that throws must not become an uncaught exception on the warning path —
      // that would take the app down over a message nobody asked to see.
    }
  }
  process.on("warning", listener)

  return () => {
    process.removeListener("warning", listener)
    for (const l of previous) {
      process.on("warning", l as (warning: Error) => void)
    }
  }
}
