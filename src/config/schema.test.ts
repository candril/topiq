import { describe, expect, test } from "bun:test"
import { ConfigError, isProd, parseConfig } from "./schema.ts"

const FILE = "test.toml"

const valid = {
  brokers: ["broker.example.com:24748"],
  registry: "https://broker.example.com:24740",
  sasl: { mechanism: "scram-sha-256", username: "sa-test" },
  password_cmd: "echo secret",
}

function config(profile: Record<string, unknown>, name = "test") {
  return { clusters: { [name]: profile } }
}

function failure(raw: unknown): string {
  try {
    parseConfig(raw, FILE)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).message
  }
  throw new Error("expected parseConfig to throw")
}

describe("parseConfig", () => {
  test("maps a full profile to camelCase fields", () => {
    const [profile] = parseConfig(
      config({
        ...valid,
        ca_cert: "/tmp/ca.pem",
        topic_prefix: "test",
        group: "orders",
        env: "test",
        allow_write: true,
      }),
      FILE,
    )
    expect(profile).toEqual({
      name: "test",
      brokers: ["broker.example.com:24748"],
      registry: "https://broker.example.com:24740",
      sasl: { mechanism: "scram-sha-256", username: "sa-test" },
      passwordCmd: "echo secret",
      caCert: "/tmp/ca.pem",
      topicPrefix: "test",
      group: "orders",
      env: "test",
      prod: undefined,
      allowWrite: true,
    })
  })

  test("allow_write defaults to false", () => {
    expect(parseConfig(config(valid), FILE)[0]!.allowWrite).toBe(false)
  })

  test("profile order follows the file", () => {
    const names = parseConfig({ clusters: { b: valid, a: valid } }, FILE).map((p) => p.name)
    expect(names).toEqual(["b", "a"])
  })

  test("missing required keys are all reported, naming file and key", () => {
    const message = failure(config({}))
    expect(message).toStartWith(`${FILE}:`)
    expect(message).toContain("clusters.test.brokers: missing")
    expect(message).toContain("clusters.test.registry: missing")
    expect(message).toContain("clusters.test.sasl: missing")
    expect(message).toContain("clusters.test.password_cmd: missing")
  })

  test("empty brokers array is rejected", () => {
    expect(failure(config({ ...valid, brokers: [] }))).toContain(
      'clusters.test.brokers: expected a non-empty array of "host:port" strings',
    )
  })

  test("broker without a port names the offending entry", () => {
    expect(failure(config({ ...valid, brokers: ["noport.example.com"] }))).toContain(
      'clusters.test.brokers[0]: "noport.example.com" is not "host:port"',
    )
  })

  test("registry must be an http(s) URL", () => {
    expect(failure(config({ ...valid, registry: "broker:24740" }))).toContain(
      'clusters.test.registry: "broker:24740" is not an http(s) URL',
    )
  })

  test("scram-sha-512 is accepted — many clusters use it", () => {
    const [profile] = parseConfig(
      config({ ...valid, sasl: { mechanism: "scram-sha-512", username: "sa-dgcli" } }),
      FILE,
    )
    expect(profile!.sasl).toEqual({ mechanism: "scram-sha-512", username: "sa-dgcli" })
  })

  test("unsupported sasl mechanism is rejected", () => {
    expect(failure(config({ ...valid, sasl: { mechanism: "plain", username: "u" } }))).toContain(
      'clusters.test.sasl.mechanism: "plain" unsupported',
    )
  })

  test("unknown key errors carry a snake_case hint", () => {
    const message = failure(config({ ...valid, allowWrite: true }))
    expect(message).toContain("clusters.test.allowWrite: unknown key")
    expect(message).toContain('did you mean "allow_write"?')
  })

  test("group without env is rejected as a pair", () => {
    expect(failure(config({ ...valid, group: "orders" }))).toContain("group and env come as a pair")
  })

  test("empty document reports no clusters", () => {
    expect(failure({})).toContain("no clusters defined")
  })

  test("unknown top-level key is rejected", () => {
    const message = failure({ clusters: { test: valid }, defaults: {} })
    expect(message).toContain("defaults: unknown key")
  })
})

describe("isProd", () => {
  const base = parseConfig(config(valid), FILE)[0]!

  test('derives from env = "prod"', () => {
    expect(isProd({ ...base, group: "g", env: "prod" })).toBe(true)
    expect(isProd({ ...base, group: "g", env: "test" })).toBe(false)
    expect(isProd(base)).toBe(false)
  })

  test("explicit prod flag wins over env", () => {
    expect(isProd({ ...base, group: "g", env: "live", prod: true })).toBe(true)
    expect(isProd({ ...base, group: "g", env: "prod", prod: false })).toBe(false)
  })
})
