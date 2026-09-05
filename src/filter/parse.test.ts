import { describe, expect, test } from "bun:test"
import { parse } from "./parse.ts"

function terms(input: string) {
  const { query, error } = parse(input)
  expect(error).toBeNull()
  return query!.terms
}

function errorOf(input: string): string {
  const { query, error } = parse(input)
  expect(query).toBeNull()
  return error!
}

describe("parse", () => {
  test("empty input is an empty query, not an error", () => {
    expect(parse("   ")).toEqual({ query: { terms: [] }, error: null })
  })

  test("field equality, ordering and negation", () => {
    expect(terms("key:12345 offset>10 -partition<2")).toEqual([
      { kind: "field", root: "key", path: [], op: "eq", literal: "12345", negated: false },
      { kind: "field", root: "offset", path: [], op: "gt", literal: "10", negated: false },
      { kind: "field", root: "partition", path: [], op: "lt", literal: "2", negated: true },
    ])
  })

  test("dotted paths keep field-name case", () => {
    expect(terms("value.Customer.Id:7")[0]).toMatchObject({
      root: "value",
      path: ["Customer", "Id"],
    })
  })

  test("root keyword is case-insensitive", () => {
    expect(terms("Value.X:1")[0]).toMatchObject({ root: "value", path: ["X"] })
  })

  test("a header name keeps its dots", () => {
    expect(terms("headers.trace.id:abc")[0]).toMatchObject({
      root: "headers",
      path: ["trace.id"],
    })
  })

  test("bare words are text terms, negatable", () => {
    expect(terms("hello -world")).toEqual([
      { kind: "text", literal: "hello", negated: false },
      { kind: "text", literal: "world", negated: true },
    ])
  })

  test("quotes hold spaces and shield the operator characters", () => {
    expect(terms('value.Name:"Ada Lovelace" "a:b c"')).toEqual([
      {
        kind: "field",
        root: "value",
        path: ["Name"],
        op: "eq",
        literal: "Ada Lovelace",
        negated: false,
      },
      { kind: "text", literal: "a:b c", negated: false },
    ])
  })

  test("only the first operator splits a term", () => {
    expect(terms("value.Url:http://x?a>b")[0]).toMatchObject({
      op: "eq",
      literal: "http://x?a>b",
    })
  })

  test("a quoted empty literal is a match, a bare one is an error", () => {
    expect(terms('key:""')[0]).toMatchObject({ literal: "" })
    expect(errorOf("key:")).toContain('expected a value after "key:"')
  })

  test("backslash escapes a quote inside a quoted literal", () => {
    expect(terms('value.Q:"say \\"hi\\""')[0]).toMatchObject({ literal: 'say "hi"' })
  })

  test("malformed input returns an error, never throws", () => {
    expect(errorOf('key:"abc')).toContain("unterminated quote")
    expect(errorOf("nope:1")).toContain('unknown field "nope"')
    expect(errorOf(":1")).toContain("expected a field name")
    expect(errorOf("value..X:1")).toContain("empty path segment")
    expect(errorOf("offset.sub:1")).toContain('"offset" has no sub-fields')
    expect(errorOf("-")).toContain('expected a term after "-"')
  })

  test("the first error wins and no partial query leaks out", () => {
    expect(parse("key:1 nope:2 value:3")).toEqual({
      query: null,
      error: expect.stringContaining('unknown field "nope"'),
    })
  })
})
