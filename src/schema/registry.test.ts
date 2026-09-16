import { afterEach, describe, expect, test } from "bun:test"
import { createRegistry, keySubject, registryFetchFailure, valueSubject } from "./registry.ts"

const SCHEMA = JSON.stringify({ type: "long" })
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(handler: (url: string) => Response): string[] {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push(url)
    return handler(url)
  }) as typeof fetch
  return calls
}

function registry() {
  return createRegistry({ host: "https://reg.example", username: "u", password: "p" })
}

describe("subjects", () => {
  test("value and key subject names", () => {
    expect(valueSubject("orders")).toBe("orders-value")
    expect(keySubject("orders")).toBe("orders-key")
  })
})

describe("getLatestSchema", () => {
  test("fetches the subject's latest version and caches it per instance", async () => {
    const calls = stubFetch(
      () => new Response(JSON.stringify({ id: 30, version: 4, schema: SCHEMA }), { status: 200 }),
    )
    const reg = registry()
    const first = await reg.getLatestSchema("orders-value")
    const second = await reg.getLatestSchema("orders-value")
    expect(first).toEqual({ subject: "orders-value", id: 30, version: 4, schema: SCHEMA })
    expect(second).toBe(first)
    expect(calls).toEqual(["https://reg.example/subjects/orders-value/versions/latest"])
  })

  test("seeds the by-id cache, so encoding then decoding costs one request", async () => {
    const calls = stubFetch(
      () => new Response(JSON.stringify({ id: 30, version: 4, schema: SCHEMA }), { status: 200 }),
    )
    const reg = registry()
    await reg.getLatestSchema("orders-value")
    expect(await reg.getSchemaById(30)).toBe(SCHEMA)
    expect(calls.length).toBe(1)
  })

  test("an unregistered subject is null, not an error", async () => {
    stubFetch(() => new Response("{}", { status: 404 }))
    expect(await registry().getLatestSchema("orders-key")).toBeNull()
  })

  test("other HTTP failures throw with the status", async () => {
    stubFetch(() => new Response("nope", { status: 401 }))
    await expect(registry().getLatestSchema("orders-value")).rejects.toThrow("HTTP 401")
  })

  test("the subject is URL-encoded", async () => {
    const calls = stubFetch(
      () => new Response(JSON.stringify({ id: 1, version: 1, schema: SCHEMA }), { status: 200 }),
    )
    await registry().getLatestSchema("a/b-value")
    expect(calls[0]).toBe("https://reg.example/subjects/a%2Fb-value/versions/latest")
  })
})

describe("getVersionForId", () => {
  const VERSIONS = JSON.stringify([
    { subject: "other-value", version: 9 },
    { subject: "orders-value", version: 4 },
  ])

  test("picks the version of the asked-for subject, not the first entry", async () => {
    // An id is shared by every subject with identical schema text, so the first entry is an
    // arbitrary one — naming it as *this* subject's version would be a plausible lie.
    stubFetch(() => new Response(VERSIONS, { status: 200 }))
    expect(await registry().getVersionForId("orders-value", 30)).toBe(4)
  })

  test("an id the subject does not carry is null, not an error", async () => {
    stubFetch(() => new Response(VERSIONS, { status: 200 }))
    expect(await registry().getVersionForId("unrelated-value", 30)).toBeNull()
  })

  test("caches per id and subject", async () => {
    const calls = stubFetch(() => new Response(VERSIONS, { status: 200 }))
    const reg = registry()
    await reg.getVersionForId("orders-value", 30)
    await reg.getVersionForId("orders-value", 30)
    expect(calls).toEqual(["https://reg.example/schemas/ids/30/versions"])
  })

  test("a 404 is null; other failures throw with the status", async () => {
    stubFetch(() => new Response("{}", { status: 404 }))
    expect(await registry().getVersionForId("orders-value", 30)).toBeNull()
    stubFetch(() => new Response("nope", { status: 500 }))
    await expect(registry().getVersionForId("orders-value", 30)).rejects.toThrow("HTTP 500")
  })
})

describe("registryFetchFailure (nfr/004)", () => {
  const host = "https://registry.example.com:24740"

  test("a trust failure names the setting that decides trust, not just OpenSSL's wording", () => {
    const error = registryFetchFailure(host, new Error("unable to get local issuer certificate"))
    expect(error.message).toBe(
      `registry TLS: unable to get local issuer certificate — check ca_cert covers ${host}`,
    )
  })

  test("the other trust wordings are recognised too", () => {
    for (const raw of [
      "unable to verify the first certificate",
      "self signed certificate in certificate chain",
      "certificate has expired",
    ]) {
      expect(registryFetchFailure(host, new Error(raw)).message).toContain("check ca_cert")
    }
  })

  test("anything else keeps its own words, with the host in front", () => {
    const error = registryFetchFailure(host, new Error("connect ECONNREFUSED"))
    expect(error.message).toBe(`registry ${host}: connect ECONNREFUSED`)
  })

  test("a non-Error rejection still produces a message", () => {
    expect(registryFetchFailure(host, "socket hang up").message).toContain("socket hang up")
  })
})
