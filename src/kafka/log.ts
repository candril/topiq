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

export function kafkaLogging(env: NodeJS.ProcessEnv = process.env): KafkaLogging {
  const path = env[KAFKA_LOG_ENV]
  if (path === undefined || path === "") {
    return { logLevel: logLevel.NOTHING, logCreator: () => () => {} }
  }
  return { logLevel: logLevel.DEBUG, logCreator: fileLogCreator(path) }
}
