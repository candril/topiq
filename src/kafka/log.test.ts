import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logLevel } from "kafkajs"
import { debugLogger, fileLogCreator, kafkaLogging } from "./log.ts"

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

describe("debugLogger (nfr/002)", () => {
  test("drops the entry when no log is configured, rather than printing it", () => {
    expect(() => debugLogger({})({ message: "x" })).not.toThrow()
    expect(() => debugLogger({ TOPIQ_KAFKA_LOG: "" })({ message: "x" })).not.toThrow()
  })

  test("appends one JSON line per entry to the configured file", () => {
    const path = tempFile()
    const log = debugLogger({ TOPIQ_KAFKA_LOG: path })
    log({ level: "WARN", namespace: "process", message: "first" })
    log({ level: "WARN", namespace: "process", message: "second" })
    const lines = readFileSync(path, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ namespace: "process", message: "first" })
  })

  test("redacts token-shaped runs, as the kafkajs sink does — a warning gets pasted into tickets too", () => {
    const path = tempFile()
    const token = "aGVsbG8tdGhpcy1pcy1hLXNlY3JldA=="
    debugLogger({ TOPIQ_KAFKA_LOG: path })({ message: `connect failed for ${token}` })
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain(token)
    expect(text).toContain("[redacted]")
  })

  test("an unwritable log file does not take the caller down", () => {
    const log = debugLogger({ TOPIQ_KAFKA_LOG: "/nonexistent-dir/topiq.log" })
    expect(() => log({ message: "x" })).not.toThrow()
  })
})

describe("what the warning sink keeps (nfr/002, nfr/003)", () => {
  test("the warning's own name survives — it is the label, not data", () => {
    const path = tempFile()
    debugLogger({ TOPIQ_KAFKA_LOG: path })({
      level: "WARN",
      namespace: "process",
      name: "TimeoutNegativeWarning",
      message: "-1789568820064 is a negative number.",
    })
    expect(JSON.parse(readFileSync(path, "utf8").trim())).toMatchObject({
      level: "WARN",
      namespace: "process",
      name: "TimeoutNegativeWarning",
      message: "-1789568820064 is a negative number.",
    })
  })

  test("a token in any other field is still redacted", () => {
    const path = tempFile()
    const token = "aGVsbG8tdGhpcy1pcy1hLXNlY3JldA=="
    debugLogger({ TOPIQ_KAFKA_LOG: path })({ name: "SomeWarning", stack: `at ${token}` })
    const written = JSON.parse(readFileSync(path, "utf8").trim())
    expect(written.name).toBe("SomeWarning")
    expect(written.stack).not.toContain(token)
  })
})
