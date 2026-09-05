import { describe, expect, test } from "bun:test"
import type { ClusterProfile } from "@/config/schema.ts"
import { pickerRows, profileAt, profileRows } from "./clusterPickerModel.ts"

function profile(overrides: Partial<ClusterProfile> & { name: string }): ClusterProfile {
  return {
    brokers: ["broker:9092"],
    registry: "https://registry",
    sasl: { mechanism: "scram-sha-256", username: "u" },
    passwordCmd: "echo x",
    allowWrite: false,
    ...overrides,
  }
}

const ordersTest = profile({ name: "orders-test", group: "orders", env: "test" })
const ordersProd = profile({ name: "orders-prod", group: "orders", env: "prod" })
const coreTest = profile({ name: "core-test", group: "core", env: "test" })
const lone = profile({ name: "solo" })

describe("pickerRows", () => {
  test("groups by group with a header row, groups sorted by name", () => {
    const rows = pickerRows([ordersTest, coreTest, ordersProd])
    expect(rows.map((r) => (r.kind === "header" ? `#${r.label}` : r.profile.name))).toEqual([
      "#core",
      "core-test",
      "#orders",
      "orders-test",
      "orders-prod",
    ])
  })

  test("prod env sorts after its siblings within a group", () => {
    const rows = pickerRows([ordersProd, ordersTest])
    const names = profileRows(rows).map((r) => r.profile.name)
    expect(names).toEqual(["orders-test", "orders-prod"])
  })

  test("prod flag without env='prod' still sorts last", () => {
    const flagged = profile({ name: "orders-live", group: "orders", env: "live", prod: true })
    const names = profileRows(pickerRows([flagged, ordersTest])).map((r) => r.profile.name)
    expect(names).toEqual(["orders-test", "orders-live"])
  })

  test("ungrouped profiles come after the groups, without a header", () => {
    const rows = pickerRows([lone, ordersTest, ordersProd])
    expect(rows.at(-1)).toMatchObject({ kind: "profile", label: "solo" })
    expect(rows.filter((r) => r.kind === "header").map((r) => r.label)).toEqual(["orders"])
  })

  test("grouped rows are labelled by env, selection indexes skip headers", () => {
    const rows = pickerRows([ordersTest, ordersProd, lone])
    const selectable = profileRows(rows)
    expect(selectable.map((r) => r.label)).toEqual(["test", "prod", "solo"])
    expect(selectable.map((r) => r.index)).toEqual([0, 1, 2])
  })
})

describe("profileAt", () => {
  test("maps the cursor over profiles only and clamps past the end", () => {
    const rows = pickerRows([ordersTest, ordersProd, lone])
    expect(profileAt(rows, 0)?.name).toBe("orders-test")
    expect(profileAt(rows, 2)?.name).toBe("solo")
    expect(profileAt(rows, 99)?.name).toBe("solo")
  })

  test("returns null with no profiles", () => {
    expect(profileAt(pickerRows([]), 0)).toBeNull()
  })
})
