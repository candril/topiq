import { appendFileSync } from "node:fs"
import { logLevel, type logCreator } from "kafkajs"
import { redact } from "@/config/secret.ts"

// kafkajs's debug log, on demand (spec 029). Off by default: the terminal is the alternate
// screen, so a console logger would corrupt the TUI — the only sink is a file, and only
// when TOPIQ_KAFKA_LOG names one. Every line goes through the same token-shaped redaction
// as password_cmd failures: kafkajs does not log the SASL secret, but a debug log is exactly
// the file that gets pasted into a ticket (nfr/003).

export const KAFKA_LOG_ENV = "TOPIQ_KAFKA_LOG"

export interface KafkaLogging {
  logLevel: logLevel
  logCreator: logCreator
}

/** Append JSON lines to `path`. Synchronous on purpose: a debug log that reorders itself
 *  around the requests it is timing is worse than one that costs a write per line. */
export function fileLogCreator(path: string): logCreator {
  return () =>
    ({ namespace, label, log }) => {
      const { message, ...extra } = log
      const line = JSON.stringify({ level: label, namespace, message, ...extra })
      try {
        appendFileSync(path, `${redact(line)}\n`)
      } catch {
        // An unwritable log file must not take the connection down with it.
      }
    }
}

/**
 * The same file as a plain JSON-line sink, for the things that are not kafkajs but still
 * must not reach the terminal — process warnings, above all (`src/warnings.ts`).
 *
 * Returns a no-op when no log is configured. Dropping a warning is deliberate: the
 * alternative is printing it onto the alternate screen, which is the corruption this
 * exists to prevent, and a reader who wants the detail sets the variable and reruns.
 */
export function debugLogger(
  env: NodeJS.ProcessEnv = process.env,
): (entry: Record<string, unknown>) => void {
  const path = env[KAFKA_LOG_ENV]
  if (path === undefined || path === "") {
    return () => {}
  }
  return (entry) => {
    try {
      appendFileSync(path, `${JSON.stringify(entry, redactValue)}\n`)
    } catch {
      // An unwritable log file must not take the caller down with it.
    }
  }
}

/** Ours or the runtime's own vocabulary, never data: a level, a namespace, a warning class
 *  name. These are exempt because every warning name is a long CamelCase run — exactly the
 *  shape the secret filter matches — so redacting them would reliably destroy the one token
 *  that says what the line is about. Every other string stays subject to it. */
const STRUCTURAL = new Set(["level", "namespace", "name"])

function redactValue(key: string, value: unknown): unknown {
  return typeof value === "string" && !STRUCTURAL.has(key) ? redact(value) : value
}

export function kafkaLogging(env: NodeJS.ProcessEnv = process.env): KafkaLogging {
  const path = env[KAFKA_LOG_ENV]
  if (path === undefined || path === "") {
    return { logLevel: logLevel.NOTHING, logCreator: () => () => {} }
  }
  return { logLevel: logLevel.DEBUG, logCreator: fileLogCreator(path) }
}
