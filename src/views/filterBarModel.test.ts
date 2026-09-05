import { describe, expect, test } from "bun:test"
import { MATCH_ALL, type Predicate } from "@/filter/types.ts"
import type { DecodedMessage } from "@/types.ts"
import {
  compileFilter,
  effectivePredicate,
  filterMode,
  filterSource,
  isFiltering,
  rowCountLabel,
  runtimeErrorLabel,
} from "./filterBarModel.ts"

function message(overrides: Partial<DecodedMessage> = {}): DecodedMessage {
  return {
    topic: "orders",
    partition: 0,
    offset: 7n,
    timestamp: new Date("2026-08-01T00:00:00Z"),
    key: null,
    value: Buffer.from("{}"),
    headers: {},
    decodedKey: 9007199254740993n,
    decodedValue: { CustomerId: 100000000000n, Name: "ada" },
    ...overrides,
  }
}

describe("filterMode / filterSource", () => {
  test("plain text is the grammar tier", () => {
    expect(filterMode("value.Name:ada")).toBe("grammar")
    expect(filterSource("value.Name:ada")).toBe("value.Name:ada")
  })

  test("a leading = selects JS and is stripped from the source", () => {
    expect(filterMode("=msg.value.CustomerId > 0n")).toBe("js")
    expect(filterSource("=msg.value.CustomerId > 0n")).toBe("msg.value.CustomerId > 0n")
  })

  test("leading whitespace does not hide the prefix", () => {
    expect(filterMode("  =msg.partition === 0")).toBe("js")
    expect(filterSource("  =msg.partition === 0")).toBe("msg.partition === 0")
  })

  test("= later in the line is grammar text, not a mode switch", () => {
    expect(filterMode("value.Name:a=b")).toBe("grammar")
  })
})

describe("compileFilter", () => {
  test("grammar terms compile and match on the decoded type", () => {
    const compiled = compileFilter("value.Name:ada")
    expect(compiled.mode).toBe("grammar")
    expect(compiled.error).toBeNull()
    expect(compiled.predicate(message())).toBe(true)
    expect(compiled.predicate(message({ decodedValue: { Name: "grace" } }))).toBe(false)
  })

  test("a key past 2^53 compares as BigInt, not through Number (nfr/006)", () => {
    // 9007199254740993 and ...92 are the same Number; only a BigInt comparison separates
    // them.
    expect(compileFilter("key:9007199254740993").predicate(message())).toBe(true)
    expect(compileFilter("key:9007199254740992").predicate(message())).toBe(false)
  })

  test("an unknown field is an error with a match-all predicate", () => {
    const compiled = compileFilter("nope:1")
    expect(compiled.error).not.toBeNull()
    expect(compiled.predicate).toBe(MATCH_ALL)
  })

  test("JS sources see the decoded value with BigInts intact", () => {
    const compiled = compileFilter("=msg.value.CustomerId > 99999999999n")
    expect(compiled.mode).toBe("js")
    expect(compiled.error).toBeNull()
    expect(compiled.predicate(message())).toBe(true)
  })

  test("a JS syntax error is reported, not thrown", () => {
    const compiled = compileFilter("=msg.value.(")
    expect(compiled.error).not.toBeNull()
    expect(compiled.predicate).toBe(MATCH_ALL)
  })

  test("a throwing JS predicate skips the row and surfaces through lastError", () => {
    const compiled = compileFilter("=msg.value.missing.deep === 1")
    expect(compiled.error).toBeNull()
    expect(compiled.predicate(message())).toBe(false)
    expect(compiled.lastError()?.offset).toBe(7n)
  })

  test("the grammar tier never reports a runtime error", () => {
    const compiled = compileFilter("value.Name:ada")
    expect(compiled.lastError()).toBeNull()
  })

  test("an empty bar matches everything in either tier", () => {
    expect(compileFilter("").predicate).toBe(MATCH_ALL)
    expect(compileFilter("=").predicate).toBe(MATCH_ALL)
    expect(compileFilter("=").error).toBeNull()
  })
})

describe("effectivePredicate", () => {
  const previous: Predicate = () => false

  test("a clean compile replaces the predicate", () => {
    const fresh: Predicate = () => true
    expect(effectivePredicate({ predicate: fresh, error: null }, previous)).toBe(fresh)
  })

  test("a malformed expression keeps the previous result set (nfr/004)", () => {
    // The compilers answer an error with MATCH_ALL; applying that would flash the whole
    // window back on the way to `key:12345`.
    expect(effectivePredicate({ predicate: MATCH_ALL, error: "boom" }, previous)).toBe(previous)
  })

  test("half-typed grammar does not widen the view", () => {
    const compiled = compileFilter("value.Name:")
    expect(compiled.error).not.toBeNull()
    expect(effectivePredicate(compiled, previous)).toBe(previous)
  })
})

describe("rowCountLabel", () => {
  test("an unfiltered window shows one number", () => {
    expect(rowCountLabel(50, 50, false)).toBe("50 rows")
  })

  test("a filtered window shows matched over total", () => {
    expect(rowCountLabel(3, 50, true)).toBe("3/50 rows")
    expect(rowCountLabel(0, 50, true)).toBe("0/50 rows")
  })

  test("matched equal to total still shows both once filtering", () => {
    expect(rowCountLabel(50, 50, true)).toBe("50/50 rows")
  })
})

describe("isFiltering", () => {
  test("blank, whitespace and a bare prefix filter nothing", () => {
    expect(isFiltering("")).toBe(false)
    expect(isFiltering("   ")).toBe(false)
    expect(isFiltering("=")).toBe(false)
    expect(isFiltering("=  ")).toBe(false)
  })

  test("any term counts as filtering", () => {
    expect(isFiltering("ada")).toBe(true)
    expect(isFiltering("=msg.partition === 0")).toBe(true)
  })
})

describe("runtimeErrorLabel", () => {
  test("pins the throw to the row that first produced it", () => {
    expect(
      runtimeErrorLabel({ message: "TypeError: x", partition: 2, offset: 41n, count: 1 }),
    ).toBe("TypeError: x — p2@41")
  })

  test("a repeat count is a tally, not a second message", () => {
    expect(
      runtimeErrorLabel({ message: "TypeError: x", partition: 2, offset: 41n, count: 12 }),
    ).toBe("TypeError: x — p2@41 ×12")
  })
})
