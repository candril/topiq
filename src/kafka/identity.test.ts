import { describe, expect, test } from "bun:test"
import { isEphemeralGroup } from "./groups.ts"
import { clientId, ephemeralGroupId, processIdentity } from "./identity.ts"

describe("identity (spec 029)", () => {
  test("client.id names user and host", () => {
    expect(clientId({ user: "stefan", host: "laptop.local" })).toBe("topiq/stefan@laptop.local")
  })

  test("characters that break metric names and log tokenising are folded", () => {
    expect(clientId({ user: "first last", host: "héllo (2)" })).toBe("topiq/first-last@h-llo-2")
    expect(clientId({ user: "", host: "" })).toBe("topiq/unknown@unknown")
  })

  test("the ephemeral group keeps the prefix the group list filters on", () => {
    const id = ephemeralGroupId({ user: "stefan", host: "h" }, () => 0.123456789)
    expect(isEphemeralGroup(id)).toBe(true)
    expect(id).toMatch(/^topiq-read-stefan-[a-z0-9]{8}$/)
  })

  test("two windows of one user get different groups", () => {
    const id = { user: "u", host: "h" }
    expect(ephemeralGroupId(id)).not.toBe(ephemeralGroupId(id))
  })

  test("the process identity is never empty", () => {
    const id = processIdentity()
    expect(id.user.length).toBeGreaterThan(0)
    expect(id.host.length).toBeGreaterThan(0)
  })
})
