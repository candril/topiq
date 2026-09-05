import { describe, expect, test } from "bun:test"
import type { ClusterProfile } from "./schema.ts"
import { copyDestinations, isSibling, mapTopicName, mappedTopic, siblingOf } from "./siblings.ts"

function profile(over: Partial<ClusterProfile> & { name: string }): ClusterProfile {
  return {
    brokers: ["broker:9092"],
    registry: "https://registry:443",
    sasl: { mechanism: "scram-sha-256", username: "u" },
    passwordCmd: "echo hunter2",
    allowWrite: false,
    ...over,
  }
}

const ordersTest = profile({
  name: "orders-test",
  group: "orders",
  env: "test",
  topicPrefix: "test",
})
const ordersProd = profile({ name: "orders-prod", group: "orders", env: "prod" })
const coreTest = profile({ name: "core-test", group: "core", env: "test", topicPrefix: "test" })
const standalone = profile({ name: "someone-elses" })

describe("isSibling", () => {
  test("same group, other env", () => {
    expect(isSibling(ordersTest, ordersProd)).toBe(true)
    expect(isSibling(ordersProd, ordersTest)).toBe(true)
  })

  test("another group is not a sibling", () => {
    expect(isSibling(ordersTest, coreTest)).toBe(false)
  })

  test("a profile without a group has no siblings — one cluster stays standalone", () => {
    expect(isSibling(standalone, profile({ name: "other" }))).toBe(false)
  })
})

describe("siblingOf", () => {
  test("resolves the other env of the family", () => {
    expect(siblingOf([ordersTest, ordersProd, coreTest], ordersProd)?.name).toBe("orders-test")
  })

  test("a third env has no single answer", () => {
    const dev = profile({ name: "orders-dev", group: "orders", env: "dev" })
    expect(siblingOf([ordersTest, ordersProd, dev], ordersProd)).toBeNull()
  })

  test("no sibling configured", () => {
    expect(siblingOf([ordersTest, coreTest], coreTest)).toBeNull()
  })
})

describe("mapTopicName", () => {
  test("prod to test gains the prefix and the common separator", () => {
    expect(mapTopicName("orders", undefined, "test")).toBe("test-orders")
  })

  test("test to prod loses prefix and separator together", () => {
    expect(mapTopicName("test-orders", "test", undefined)).toBe("orders")
  })

  test("the separator the source used is the one the destination gets", () => {
    expect(mapTopicName("test.orders", "test", "stage")).toBe("stage.orders")
  })

  test("a prefix that already ends in a separator does not gain a second", () => {
    expect(mapTopicName("orders", undefined, "test-")).toBe("test-orders")
  })

  test("a topic that does not carry the source prefix is left alone", () => {
    expect(mapTopicName("orders", "other", undefined)).toBe("orders")
  })

  test("no prefixes either side is the identity, not a guessed rename", () => {
    expect(mapTopicName("orders")).toBe("orders")
  })

  test("mappedTopic reads the prefixes off the two profiles", () => {
    expect(mappedTopic("orders", ordersProd, ordersTest)).toBe("test-orders")
    expect(mappedTopic("test-orders", ordersTest, ordersProd)).toBe("orders")
  })
})

describe("copyDestinations", () => {
  test("the source is never its own destination", () => {
    const names = copyDestinations([ordersTest, ordersProd], ordersTest).map((p) => p.name)
    expect(names).not.toContain("orders-test")
  })

  test("the non-prod sibling leads", () => {
    const names = copyDestinations([ordersProd, coreTest, ordersTest], ordersProd).map(
      (p) => p.name,
    )
    expect(names[0]).toBe("orders-test")
  })

  test("prod sorts last even when it is the sibling — it is never the default row", () => {
    const names = copyDestinations([ordersTest, ordersProd, coreTest], ordersTest).map(
      (p) => p.name,
    )
    expect(names).toEqual(["core-test", "orders-prod"])
  })

  test("a declared prod = true env with another name still sorts last", () => {
    const staging = profile({ name: "z-staging", group: "other", env: "staging" })
    const live = profile({ name: "a-live", group: "other", env: "live", prod: true })
    const names = copyDestinations([staging, live, ordersTest], ordersTest).map((p) => p.name)
    expect(names).toEqual(["z-staging", "a-live"])
  })
})
