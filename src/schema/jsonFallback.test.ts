import { describe, expect, test } from "bun:test"
import { parseJsonLossless } from "./jsonFallback.ts"

describe("parseJsonLossless", () => {
  test("an integer past 2^53 survives exactly as BigInt", () => {
    const parsed = parseJsonLossless('{"CustomerId":9007199254740993}') as {
      CustomerId: bigint
    }
    expect(typeof parsed.CustomerId).toBe("bigint")
    expect(parsed.CustomerId).toBe(9007199254740993n)
    // The bug this exists to prevent: plain JSON.parse rounds this to ...992.
    expect(JSON.parse('{"CustomerId":9007199254740993}').CustomerId).toBe(9007199254740992)
  })

  test("negative large integers too", () => {
    expect(parseJsonLossless("[-9007199254740993]")).toEqual([-9007199254740993n])
  })

  test("safe-range integers stay Numbers", () => {
    expect(parseJsonLossless('{"a":42,"b":-7,"c":9007199254740991}')).toEqual({
      a: 42,
      b: -7,
      c: 9007199254740991,
    })
  })

  test("floats and exponents are never promoted", () => {
    expect(parseJsonLossless('{"a":1.5,"b":1e21}')).toEqual({ a: 1.5, b: 1e21 })
  })

  test("nested and array positions are covered", () => {
    const parsed = parseJsonLossless('{"o":{"ids":[9007199254740993,1]}}') as {
      o: { ids: unknown[] }
    }
    expect(parsed.o.ids[0]).toBe(9007199254740993n)
    expect(parsed.o.ids[1]).toBe(1)
  })

  test("strings, null and booleans pass through", () => {
    expect(parseJsonLossless('{"s":"9007199254740993","n":null,"b":true}')).toEqual({
      s: "9007199254740993",
      n: null,
      b: true,
    })
  })
})
