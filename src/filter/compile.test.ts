import { describe, expect, test } from "bun:test"
import type { DecodedMessage } from "@/types.ts"
import { compile, compileQuery } from "./compile.ts"
import { parse } from "./parse.ts"

// Above 2^53: BIG and BIG - 1n are the same Number. Every BigInt assertion below uses the
// pair, because a comparator that leaks through Number cannot tell them apart (nfr/006).
const BIG = 9007199254740993n
const BIG_NEIGHBOUR = 9007199254740992n

function msg(overrides: Partial<DecodedMessage> = {}): DecodedMessage {
  return {
    topic: "t",
    partition: 0,
    offset: 0n,
    timestamp: new Date("2026-08-01T12:00:00Z"),
    key: null,
    value: null,
    headers: {},
    decodedKey: null,
    decodedValue: null,
    ...overrides,
  }
}

function matches(input: string, message: DecodedMessage): boolean {
  const { predicate, error } = compile(input)
  expect(error).toBeNull()
  return predicate(message)
}

function errorOf(input: string): string {
  const { error } = compile(input)
  expect(error).not.toBeNull()
  return error!
}

describe("compile — BigInt fidelity (nfr/006)", () => {
  test("a BigInt key matches a plain decimal literal", () => {
    expect(matches("key:12345", msg({ decodedKey: 12345n }))).toBe(true)
  })

  test("key equality above 2^53 is exact, not Number-rounded", () => {
    const message = msg({ decodedKey: BIG })
    expect(matches(`key:${BIG}`, message)).toBe(true)
    expect(matches(`key:${BIG_NEIGHBOUR}`, message)).toBe(false)
  })

  test("offset ordering above 2^53 is exact", () => {
    expect(matches(`offset>${BIG_NEIGHBOUR}`, msg({ offset: BIG }))).toBe(true)
    expect(matches(`offset>${BIG}`, msg({ offset: BIG }))).toBe(false)
    expect(matches(`offset<${BIG}`, msg({ offset: BIG_NEIGHBOUR }))).toBe(true)
  })

  test("a nested BigInt field compares as BigInt", () => {
    const message = msg({ decodedValue: { Customer: { Id: BIG } } })
    expect(matches(`value.Customer.Id:${BIG}`, message)).toBe(true)
    expect(matches(`value.Customer.Id:${BIG_NEIGHBOUR}`, message)).toBe(false)
    expect(matches(`value.Customer.Id>${BIG_NEIGHBOUR}`, message)).toBe(true)
  })

  test("a non-integer literal never matches a BigInt field", () => {
    expect(matches("key:12345.0", msg({ decodedKey: 12345n }))).toBe(false)
    expect(matches("key:12345n", msg({ decodedKey: 12345n }))).toBe(false)
  })
})

describe("compile — scalar types", () => {
  test("numbers compare numerically", () => {
    expect(matches("partition:2", msg({ partition: 2 }))).toBe(true)
    expect(matches("partition>1", msg({ partition: 2 }))).toBe(true)
    expect(matches("partition<2", msg({ partition: 2 }))).toBe(false)
    expect(matches("value.Score>1.5", msg({ decodedValue: { Score: 2.25 } }))).toBe(true)
  })

  test("strings are equality (case-insensitive), not substring", () => {
    const message = msg({ decodedValue: { Name: "Ada Lovelace" } })
    expect(matches('value.Name:"ada lovelace"', message)).toBe(true)
    expect(matches("value.Name:Ada", message)).toBe(false)
    expect(matches("value.Name>Aa", message)).toBe(true)
  })

  test("booleans match true/false only", () => {
    const message = msg({ decodedValue: { IsOnboarded: true } })
    expect(matches("value.IsOnboarded:true", message)).toBe(true)
    expect(matches("value.IsOnboarded:TRUE", message)).toBe(true)
    expect(matches("value.IsOnboarded:false", message)).toBe(false)
    expect(matches("value.IsOnboarded:1", message)).toBe(false)
  })

  test("dates parse ISO-8601; a day literal is that whole UTC day", () => {
    const message = msg({ timestamp: new Date("2026-08-01T12:00:00Z") })
    expect(matches("timestamp:2026-08-01", message)).toBe(true)
    expect(matches("timestamp:2026-08-02", message)).toBe(false)
    expect(matches("timestamp>2026-08-01", message)).toBe(true)
    expect(matches("timestamp<2026-08-01T13:00:00Z", message)).toBe(true)
    expect(matches("timestamp>2026-08-01T13:00:00Z", message)).toBe(false)
  })

  test("a decoded date field compares as a date", () => {
    const message = msg({ decodedValue: { UpdateDate: new Date("2026-08-05T00:00:00Z") } })
    expect(matches("value.UpdateDate>2026-08-01", message)).toBe(true)
    expect(matches("value.UpdateDate<2026-08-01", message)).toBe(false)
  })

  test("undecodable bytes match on utf-8 or hex", () => {
    const message = msg({ decodedKey: Buffer.from("deadbeef", "hex") })
    expect(matches("key:deadbeef", message)).toBe(true)
    expect(matches("key:0xdeadbeef", message)).toBe(true)
    expect(matches("key:cafe", message)).toBe(false)
    expect(matches("key:hi", msg({ decodedKey: Buffer.from("hi", "utf8") }))).toBe(true)
  })
})

describe("compile — containers", () => {
  test("an array matches per element, not over its rendering", () => {
    const message = msg({ decodedValue: { Tags: ["alpha", "beta"] } })
    expect(matches("value.Tags:beta", message)).toBe(true)
    expect(matches("value.Tags:bet", message)).toBe(false)
    expect(matches("value.Tags.1:beta", message)).toBe(true)
    expect(matches("value.Tags.9:beta", message)).toBe(false)
  })

  test("a record term searches the subtree", () => {
    const message = msg({ decodedValue: { Nested: { Deep: "needle" } } })
    expect(matches("value.Nested:needle", message)).toBe(true)
    expect(matches("value.Nested:missing", message)).toBe(false)
    expect(matches("value.Nested>needle", message)).toBe(false)
  })

  test("empty containers are matchable and distinct from null", () => {
    const message = msg({ decodedValue: { Tags: [], Meta: {} } })
    expect(matches("value.Tags:anything", message)).toBe(false)
    expect(matches("value.Tags:null", message)).toBe(false)
    expect(matches("-value.Tags:null", message)).toBe(true)
  })
})

describe("compile — headers", () => {
  const message = msg({
    headers: { traceid: Buffer.from("abc123"), "trace.id": Buffer.from("dotted") },
  })

  test("a header is addressed by name, dots included", () => {
    expect(matches("headers.traceid:abc123", message)).toBe(true)
    expect(matches("headers.trace.id:dotted", message)).toBe(true)
    expect(matches("headers.traceid:nope", message)).toBe(false)
  })

  test("an absent header does not match, and its negation does", () => {
    expect(matches("headers.missing:abc123", message)).toBe(false)
    expect(matches("-headers.missing:abc123", message)).toBe(true)
  })

  test("the bare root searches all header values", () => {
    expect(matches("headers:abc123", message)).toBe(true)
    expect(matches("headers:zzz", message)).toBe(false)
  })
})

describe("compile — absent, null and tombstones", () => {
  const message = msg({ decodedValue: { Note: null } })

  test("null matches only where a field is really null", () => {
    expect(matches("value.Note:null", message)).toBe(true)
    expect(matches("value.Missing:null", message)).toBe(false)
    expect(matches("-value.Missing:null", message)).toBe(true)
  })

  test("an absent path never matches, whatever the operator", () => {
    expect(matches("value.Missing:1", message)).toBe(false)
    expect(matches("value.Missing>1", message)).toBe(false)
    expect(matches("value.Missing<1", message)).toBe(false)
    expect(matches("-value.Missing:1", message)).toBe(true)
  })

  test("traversing through null or a scalar is absence, not a crash", () => {
    expect(matches("value.Note.Deeper:1", message)).toBe(false)
    expect(matches("value.Note.Deeper:null", message)).toBe(false)
    expect(matches("key.Any:1", msg({ decodedKey: 5n }))).toBe(false)
  })

  test("a tombstone is a value of null, not an empty row", () => {
    const tombstone = msg({ decodedKey: 7n, decodedValue: null })
    expect(matches("value:null", tombstone)).toBe(true)
    expect(matches("value.Anything:null", tombstone)).toBe(false)
    expect(matches("key:7 value:null", tombstone)).toBe(true)
    expect(matches("anything", tombstone)).toBe(false)
  })
})

describe("compile — text terms and composition", () => {
  const message = msg({
    decodedKey: "zebra",
    decodedValue: { Name: "Ada Lovelace", Customer: { Id: BIG } },
  })

  test("a bare word is a substring of the decoded value, case-insensitive", () => {
    expect(matches("lovelace", message)).toBe(true)
    expect(matches("LOVELACE", message)).toBe(true)
    expect(matches("nomatch", message)).toBe(false)
  })

  test("a bare word searches the value, not the key", () => {
    expect(matches("zebra", message)).toBe(false)
    expect(matches("key:zebra", message)).toBe(true)
  })

  test("BigInts in the rendered value are searchable as their digits", () => {
    expect(matches(String(BIG), message)).toBe(true)
    expect(matches(String(BIG_NEIGHBOUR), message)).toBe(false)
  })

  test("terms are ANDed and negation excludes", () => {
    expect(matches('value.Name:"Ada Lovelace" lovelace', message)).toBe(true)
    expect(matches('value.Name:"Ada Lovelace" nomatch', message)).toBe(false)
    expect(matches("-lovelace", message)).toBe(false)
    expect(matches("-nomatch", message)).toBe(true)
    expect(matches("lovelace -value.Name:Bob", message)).toBe(true)
  })

  test("an empty expression matches everything", () => {
    const result = compile("   ")
    expect(result.error).toBeNull()
    expect(result.predicate(message)).toBe(true)
    expect(result.predicate(msg())).toBe(true)
  })

  test("compileQuery consumes a parsed AST directly", () => {
    const { query } = parse("value.Name:Ada")
    expect(compileQuery(query!)(msg({ decodedValue: { Name: "ada" } }))).toBe(true)
  })
})

describe("compile — malformed input", () => {
  test("a parse error surfaces and the predicate stays neutral", () => {
    const result = compile("nope:1")
    expect(result.error).toContain('unknown field "nope"')
    expect(result.predicate(msg())).toBe(true)
  })

  test("envelope scalars reject a literal they can never match", () => {
    expect(errorOf("offset>abc")).toContain("offset expects a whole number")
    expect(errorOf("partition:x")).toContain("partition expects a whole number")
    expect(errorOf("timestamp>yesterday")).toContain("timestamp expects an ISO-8601 date")
    expect(errorOf("timestamp:2026-13-45")).toContain("timestamp expects an ISO-8601 date")
  })

  test("compile never throws, whatever is typed", () => {
    const inputs = ['"', "-", ":", ">", "<", "value.", ".value:1", "key::", "@#$%", "a".repeat(500)]
    for (const input of inputs) {
      const result = compile(input)
      expect(() => result.predicate(msg())).not.toThrow()
    }
  })

  test("a value that throws while being read skips the row instead of the view", () => {
    const hostile = {} as Record<string, unknown>
    Object.defineProperty(hostile, "Boom", {
      enumerable: true,
      get() {
        throw new Error("decode is lying")
      },
    })
    const message = msg({ decodedValue: hostile })
    expect(matches("needle", message)).toBe(false)
    expect(matches("value.Boom:1", message)).toBe(false)
  })

  test("a cyclic decoded value does not hang the predicate", () => {
    const cyclic: Record<string, unknown> = { Name: "loop" }
    cyclic.Self = cyclic
    const message = msg({ decodedValue: cyclic })
    expect(matches("loop", message)).toBe(true)
  })
})

describe("regex literals (monq-style /pattern/)", () => {
  const row = msg({
    decodedValue: {
      loginAccountId: "acct-pansen-42",
      CustomerId: 717197126n,
      Tags: ["alpha", "beta"],
    },
  })

  test("a slash literal matches a substring of a string field", () => {
    expect(matches("value.loginAccountId:/pansen/", row)).toBe(true)
    expect(matches("value.loginAccountId:/hansen/", row)).toBe(false)
  })

  test("anchors and character classes work", () => {
    expect(matches("value.loginAccountId:/^acct-/", row)).toBe(true)
    expect(matches("value.loginAccountId:/^pansen/", row)).toBe(false)
    expect(matches("value.loginAccountId:/[0-9]+$/", row)).toBe(true)
  })

  test("case-insensitive by default, overridable with explicit flags", () => {
    expect(matches("value.loginAccountId:/PANSEN/", row)).toBe(true)
    expect(matches("value.loginAccountId:/PANSEN/g", row)).toBe(false)
  })

  test("a regex tests the rendered form of a BigInt, losslessly", () => {
    expect(matches("value.CustomerId:/^71719/", row)).toBe(true)
    expect(matches("value.CustomerId:/^81719/", row)).toBe(false)
  })

  test("arrays match per element", () => {
    expect(matches("value.Tags:/^bet/", row)).toBe(true)
    expect(matches("value.Tags:/^gam/", row)).toBe(false)
  })

  test("negation applies to the whole pattern", () => {
    expect(matches("-value.loginAccountId:/pansen/", row)).toBe(false)
    expect(matches("-value.loginAccountId:/hansen/", row)).toBe(true)
  })

  test("a malformed pattern is a plain literal, not a crash", () => {
    const result = compile("value.loginAccountId:/[unclosed/")
    expect(result.error).toBeNull()
    expect(result.predicate(row)).toBe(false)
  })

  test("a value that merely contains a slash stays a plain string", () => {
    const withPath = msg({ decodedValue: { loginAccountId: "a/b" } })
    expect(matches("value.loginAccountId:a/b", withPath)).toBe(true)
  })
})
