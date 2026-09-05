import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClusterProfile } from "@/config/schema.ts"
import type { TopicSummary } from "@/types.ts"
import { readTopicCache, writeTopicCache } from "./topics.ts"

const profile: ClusterProfile = {
  name: "core-test",
  brokers: ["core-test.example.com:24748"],
  registry: "https://core-test.example.com:24740",
  sasl: { mechanism: "scram-sha-512", username: "sa-dgcli" },
  passwordCmd: "echo secret",
  allowWrite: false,
}

const topics: TopicSummary[] = [
  { name: "test-dg-payables-creditnoteupdated-v2", partitionCount: 5 },
  { name: "test-dg-availability-availabilityupdated-v1", partitionCount: 12 },
]

const NOW = 1_800_000_000_000

let home: string
let previous: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "topiq-cache-"))
  previous = process.env["XDG_CACHE_HOME"]
  process.env["XDG_CACHE_HOME"] = home
})

afterEach(() => {
  if (previous === undefined) {
    delete process.env["XDG_CACHE_HOME"]
  } else {
    process.env["XDG_CACHE_HOME"] = previous
  }
  rmSync(home, { recursive: true, force: true })
})

function corrupt(contents: string): void {
  const dir = join(home, "topiq", "topics")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "core-test.json"), contents)
}

describe("topic cache", () => {
  test("a miss is null, not an error", () => {
    expect(readTopicCache(profile, NOW)).toBeNull()
  })

  test("round-trips a listing", () => {
    writeTopicCache(profile, topics, NOW)
    expect(readTopicCache(profile, NOW)).toEqual(topics)
  })

  test("a profile repointed at other brokers does not read the old cluster's topics", () => {
    writeTopicCache(profile, topics, NOW)
    const moved = { ...profile, brokers: ["core-prod.example.com:24748"] }
    expect(readTopicCache(moved, NOW)).toBeNull()
  })

  test("an entry older than the max age is dropped", () => {
    writeTopicCache(profile, topics, NOW)
    const eightDays = NOW + 8 * 24 * 60 * 60 * 1000
    expect(readTopicCache(profile, eightDays)).toBeNull()
    expect(readTopicCache(profile, NOW + 60_000)).toEqual(topics)
  })

  test("unreadable or foreign contents read as a miss", () => {
    corrupt("{ not json")
    expect(readTopicCache(profile, NOW)).toBeNull()
    corrupt(JSON.stringify({ brokers: profile.brokers, fetchedAt: NOW, topics: [{ name: 1 }] }))
    expect(readTopicCache(profile, NOW)).toBeNull()
  })

  test("a profile name that is not a filename still round-trips", () => {
    const odd = { ...profile, name: "dg/test prod" }
    writeTopicCache(odd, topics, NOW)
    expect(readTopicCache(odd, NOW)).toEqual(topics)
  })
})
