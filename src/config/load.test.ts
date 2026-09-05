import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { configPath, loadConfig } from "./load.ts"
import { ConfigError } from "./schema.ts"

const dir = mkdtempSync(join(tmpdir(), "topiq-config-"))
let fixtureId = 0

async function fixture(toml: string): Promise<string> {
  const path = join(dir, `config-${fixtureId++}.toml`)
  await Bun.write(path, toml)
  return path
}

const VALID = `
[clusters.orders-test]
brokers = ["kafka-test.example.aivencloud.com:24748"]
registry = "https://kafka-test.example.aivencloud.com:24740"
sasl = { mechanism = "scram-sha-256", username = "svc-orders" }
password_cmd = "echo secret"
ca_cert = "~/.config/topiq/ca.pem"
topic_prefix = "test"
group = "orders"
env = "test"
`

describe("loadConfig", () => {
  test("parses a TOML fixture into a profile", async () => {
    const [profile] = await loadConfig(await fixture(VALID))
    expect(profile!.name).toBe("orders-test")
    expect(profile!.brokers).toEqual(["kafka-test.example.aivencloud.com:24748"])
    expect(profile!.sasl).toEqual({ mechanism: "scram-sha-256", username: "svc-orders" })
    expect(profile!.passwordCmd).toBe("echo secret")
    expect(profile!.group).toBe("orders")
    expect(profile!.env).toBe("test")
    expect(profile!.allowWrite).toBe(false)
  })

  test("expands ~ in ca_cert", async () => {
    const [profile] = await loadConfig(await fixture(VALID))
    expect(profile!.caCert).toBe(join(homedir(), ".config", "topiq", "ca.pem"))
  })

  test("missing file errors actionably instead of stack-tracing", async () => {
    const path = join(dir, "nope.toml")
    expect(loadConfig(path)).rejects.toThrow(ConfigError)
    expect(loadConfig(path)).rejects.toThrow(`${path}: not found`)
  })

  test("TOML syntax errors name the file", async () => {
    const path = await fixture("not = = toml")
    expect(loadConfig(path)).rejects.toThrow(`${path}: invalid TOML`)
  })

  test("validation errors surface from the file path", async () => {
    const path = await fixture(`[clusters.broken]\nbrokers = []\n`)
    expect(loadConfig(path)).rejects.toThrow("clusters.broken.brokers")
  })

  test("re-reads an edited file within one process", async () => {
    const path = await fixture(VALID)
    await loadConfig(path)
    await Bun.write(path, VALID.replace('env = "test"', 'env = "prod"'))
    const [profile] = await loadConfig(path)
    expect(profile!.env).toBe("prod")
  })
})

describe("configPath", () => {
  const original = process.env["TOPIQ_CONFIG"]

  afterEach(() => {
    if (original === undefined) {
      delete process.env["TOPIQ_CONFIG"]
    } else {
      process.env["TOPIQ_CONFIG"] = original
    }
  })

  test("defaults to ~/.config/topiq/config.toml", () => {
    delete process.env["TOPIQ_CONFIG"]
    expect(configPath()).toBe(join(homedir(), ".config", "topiq", "config.toml"))
  })

  test("TOPIQ_CONFIG overrides the default", () => {
    process.env["TOPIQ_CONFIG"] = "/tmp/other.toml"
    expect(configPath()).toBe("/tmp/other.toml")
  })
})
