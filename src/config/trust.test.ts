import { describe, expect, test } from "bun:test"
import { rootCertificates } from "node:tls"
import { trustAnchors } from "./trust.ts"

const PRIVATE_CA = "-----BEGIN CERTIFICATE-----\nproject-ca\n-----END CERTIFICATE-----\n"

describe("trustAnchors (nfr/003)", () => {
  test("keeps every public root and adds the private CA", () => {
    const anchors = trustAnchors(PRIVATE_CA)
    expect(anchors).toHaveLength(rootCertificates.length + 1)
    expect(anchors).toContain(PRIVATE_CA)
    expect(anchors.slice(0, -1)).toEqual([...rootCertificates])
  })

  test("the roots are not empty — the whole point is that they survive", () => {
    // A private CA handed to Node or Bun replaces the trust store outright. If this ever
    // reads 0, `ca_cert` has silently become pinning again and a publicly-rooted registry
    // stops verifying.
    expect(rootCertificates.length).toBeGreaterThan(20)
  })

  test("does not mutate the runtime's root list", () => {
    const before = rootCertificates.length
    trustAnchors(PRIVATE_CA)
    expect(rootCertificates).toHaveLength(before)
  })
})
