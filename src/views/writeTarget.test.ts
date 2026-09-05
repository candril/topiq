import { describe, expect, test } from "bun:test"
import type { ClusterSession } from "@/clusterSession.ts"
import type { ClusterProfile } from "@/config/schema.ts"
import type { KafkaClient } from "@/kafka/types.ts"
import type { PendingWrite } from "@/state/types.ts"
import { writeTarget } from "./produceFlows.ts"

// A copy's bytes are encoded for the destination registry and are meaningless anywhere else
// (spec 016). The dialog names one cluster; this is what makes the produce go to that one or
// to none, rather than to whichever client the view had at hand.

function profile(name: string): ClusterProfile {
  return {
    name,
    brokers: ["broker:9092"],
    registry: "https://registry:443",
    sasl: { mechanism: "scram-sha-256", username: "u" },
    passwordCmd: "echo hunter2",
    allowWrite: true,
  }
}

const sourceClient = {} as KafkaClient
const destClient = {} as KafkaClient
const source = { client: sourceClient, profile: profile("orders-prod") }
const destination = {
  profile: profile("orders-test"),
  client: destClient,
} as ClusterSession

function pending(cluster: string): PendingWrite {
  return {
    prompt: {
      kind: "copy",
      title: "Copy",
      lines: [],
      warnings: [],
      confirmKey: "C",
      hint: "",
      prod: false,
      typeToConfirm: null,
    },
    action: {
      kind: "copy",
      topic: "test-orders",
      count: 1,
      oldest: new Date(0),
      from: source.profile,
      fromTopic: "dg-orders",
      schemas: [],
    },
    produce: { topic: "test-orders", records: [] },
    cluster,
  }
}

describe("writeTarget", () => {
  test("the connected cluster answers for its own writes", () => {
    expect(writeTarget(pending("orders-prod"), source, null)?.client).toBe(sourceClient)
  })

  test("a copy goes through the destination connection, not the connected one", () => {
    expect(writeTarget(pending("orders-test"), source, destination)?.client).toBe(destClient)
  })

  test("the destination profile comes along — allow_write is rechecked against it", () => {
    expect(writeTarget(pending("orders-test"), source, destination)?.profile.name).toBe(
      "orders-test",
    )
  })

  test("a cluster this session does not hold is null, never a substitute", () => {
    expect(writeTarget(pending("core-test"), source, destination)).toBeNull()
  })

  test("a destination that has since been replaced does not answer for the old one", () => {
    const other = { profile: profile("core-test"), client: {} as KafkaClient } as ClusterSession
    expect(writeTarget(pending("orders-test"), source, other)).toBeNull()
  })
})
