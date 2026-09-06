import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logLevel } from "kafkajs"
import { fileLogCreator, kafkaLogging } from "./log.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "topiq-log-"))
  dirs.push(dir)
  return join(dir, "kafka.log")
}

describe("kafka log sink (spec 029)", () => {
  test("off unless TOPIQ_KAFKA_LOG names a file", () => {
    expect(kafkaLogging({}).logLevel).toBe(logLevel.NOTHING)
    expect(kafkaLogging({ TOPIQ_KAFKA_LOG: "" }).logLevel).toBe(logLevel.NOTHING)
    expect(kafkaLogging({ TOPIQ_KAFKA_LOG: "/tmp/x" }).logLevel).toBe(logLevel.DEBUG)
  })

  test("writes one JSON line per entry with the namespace and extras", () => {
    const path = tempFile()
    const log = fileLogCreator(path)(logLevel.DEBUG)
    log({
      namespace: "Connection",
      level: logLevel.DEBUG,
      label: "DEBUG",
      log: { timestamp: "t", message: "Request JoinGroup", broker: "b:9092", correlationId: 3 },
    })
    const [line] = readFileSync(path, "utf8").trim().split("\n")
    expect(JSON.parse(line!)).toEqual({
      level: "DEBUG",
      namespace: "Connection",
      message: "Request JoinGroup",
      timestamp: "t",
      broker: "b:9092",
      correlationId: 3,
    })
  })

  test("token-shaped strings never reach the file", () => {
    const path = tempFile()
    const log = fileLogCreator(path)(logLevel.DEBUG)
    const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
    log({
      namespace: "SASL",
      level: logLevel.ERROR,
      label: "ERROR",
      log: { timestamp: "t", message: `auth failed for ${token}` },
    })
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain(token)
    expect(text).toContain("[redacted]")
  })

  test("an unwritable path is swallowed, not thrown", () => {
    const log = fileLogCreator("/nonexistent-dir/topiq/kafka.log")(logLevel.DEBUG)
    expect(() =>
      log({
        namespace: "",
        level: logLevel.INFO,
        label: "INFO",
        log: { timestamp: "t", message: "m" },
      }),
    ).not.toThrow()
  })
})
