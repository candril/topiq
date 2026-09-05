import { describe, expect, test } from "bun:test"
import { createDemoRegistry } from "./registry.ts"
import { CUSTOMERS, ORDERS, seedCluster, UNREGISTERED_SCHEMA_ID } from "./seed.ts"

const registry = createDemoRegistry(seedCluster({ epoch: new Date("2026-09-06T10:00:00Z") }))

describe("demo registry", () => {
  test("resolves seeded ids and refuses the unregistered one by id", async () => {
    expect(JSON.parse(await registry.getSchemaById(2)).name).toBe("OrderPlaced")
    await expect(registry.getSchemaById(UNREGISTERED_SCHEMA_ID)).rejects.toThrow(
      `schema id ${UNREGISTERED_SCHEMA_ID} is not registered`,
    )
  })

  test("latest per subject is the highest version, and an unknown subject is null", async () => {
    const latest = await registry.getLatestSchema(`${CUSTOMERS}-value`)
    expect(latest).toMatchObject({ id: 5, version: 3 })
    expect(await registry.getLatestSchema(`${ORDERS}-key`)).toMatchObject({ id: 1, version: 1 })
    expect(await registry.getLatestSchema("nope-value")).toBeNull()
  })

  test("version lookup is per subject: a shared id has a version under each", async () => {
    expect(await registry.getVersionForId(`${ORDERS}-key`, 1)).toBe(1)
    expect(await registry.getVersionForId(`${CUSTOMERS}-key`, 1)).toBe(1)
    expect(await registry.getVersionForId(`${ORDERS}-value`, 1)).toBeNull()
  })
})
