import { describe, expect, test } from "bun:test"
import {
  halfPage,
  levelNav,
  listNav,
  modified,
  normalizeKey,
  pageNav,
  type RawKey,
} from "./keys.ts"

describe("normalizeKey", () => {
  test("lowercases an implicit-shift uppercase name and sets shift", () => {
    expect(normalizeKey({ name: "H", shift: false })).toEqual({
      name: "h",
      shift: true,
      ctrl: false,
      meta: false,
    })
  })

  test("keeps an explicit shift + lowercase name", () => {
    expect(normalizeKey({ name: "h", shift: true }).shift).toBe(true)
  })

  test("plain lowercase key has no shift", () => {
    expect(normalizeKey({ name: "q" })).toEqual({
      name: "q",
      shift: false,
      ctrl: false,
      meta: false,
    })
  })

  test("multi-char names pass through untouched", () => {
    expect(normalizeKey({ name: "escape" }).name).toBe("escape")
    expect(normalizeKey({ name: "escape" }).shift).toBe(false)
  })

  test("missing name becomes empty string", () => {
    expect(normalizeKey({}).name).toBe("")
  })

  test("modifiers carry through", () => {
    const k = normalizeKey({ name: "c", ctrl: true, meta: true })
    expect(k.ctrl).toBe(true)
    expect(k.meta).toBe(true)
  })
})

describe("levelNav", () => {
  const nav = (key: Parameters<typeof normalizeKey>[0], letters?: boolean) =>
    levelNav(normalizeKey(key), letters === undefined ? {} : { letters })

  test("l and the right arrow descend, h and the left arrow ascend", () => {
    expect(nav({ name: "l" })).toBe("descend")
    expect(nav({ name: "right" })).toBe("descend")
    expect(nav({ name: "h" })).toBe("ascend")
    expect(nav({ name: "left" })).toBe("ascend")
  })

  test("letters: false leaves h/l as text but keeps the arrows", () => {
    expect(nav({ name: "l" }, false)).toBeNull()
    expect(nav({ name: "h" }, false)).toBeNull()
    expect(nav({ name: "right" }, false)).toBe("descend")
    expect(nav({ name: "left" }, false)).toBe("ascend")
  })

  test("ctrl+h is backspace on many terminals, never an ascend", () => {
    expect(nav({ name: "h", ctrl: true })).toBeNull()
    expect(nav({ name: "l", meta: true })).toBeNull()
  })

  test("shift+h/l stay free for view-local bindings", () => {
    expect(nav({ name: "H" })).toBeNull()
    expect(nav({ name: "L" })).toBeNull()
  })

  test("keys that move the cursor are not level moves", () => {
    expect(nav({ name: "j" })).toBeNull()
    expect(nav({ name: "return" })).toBeNull()
    expect(nav({ name: "escape" })).toBeNull()
  })
})

describe("listNav ctrlPrev", () => {
  const nav = (key: RawKey, ctrlPrev?: boolean) =>
    listNav(normalizeKey(key), ctrlPrev === undefined ? {} : { ctrlPrev })

  test("^p is previous by default — inside a list it navigates (spec 020)", () => {
    expect(nav({ name: "p", ctrl: true })).toBe("prev")
  })

  test("ctrlPrev: false hands ^p to the palette without touching the other synonyms", () => {
    expect(nav({ name: "p", ctrl: true }, false)).toBeNull()
    expect(nav({ name: "n", ctrl: true }, false)).toBe("next")
    expect(nav({ name: "k" }, false)).toBe("prev")
    expect(nav({ name: "up" }, false)).toBe("prev")
  })

  test("a plain p is still a view-local key either way", () => {
    expect(nav({ name: "p" })).toBeNull()
    expect(nav({ name: "p" }, false)).toBeNull()
  })
})

describe("listNav and levelNav do not overlap", () => {
  test("no key means both a row move and a level move", () => {
    for (const name of ["j", "k", "h", "l", "up", "down", "left", "right", "n", "p"]) {
      for (const ctrl of [false, true]) {
        const k = normalizeKey({ name, ctrl })
        expect(listNav(k) === null || levelNav(k) === null).toBe(true)
      }
    }
  })
})

describe("pageNav", () => {
  const nav = (key: RawKey) => pageNav(normalizeKey(key))

  test("^d and ^u move half a page", () => {
    expect(nav({ name: "d", ctrl: true })).toBe("down")
    expect(nav({ name: "u", ctrl: true })).toBe("up")
  })

  test("plain d and u are free for other bindings", () => {
    expect(nav({ name: "d" })).toBeNull()
    expect(nav({ name: "u" })).toBeNull()
  })

  test("other modifiers decline, so ⇧^D stays available", () => {
    expect(nav({ name: "d", ctrl: true, shift: true })).toBeNull()
    expect(nav({ name: "d", ctrl: true, meta: true })).toBeNull()
  })

  test("does not overlap row or level navigation", () => {
    for (const name of ["d", "u"]) {
      const k = normalizeKey({ name, ctrl: true })
      expect(listNav(k)).toBeNull()
      expect(levelNav(k)).toBeNull()
    }
  })
})

describe("halfPage", () => {
  test("half the viewport, and never zero", () => {
    expect(halfPage(20)).toBe(10)
    expect(halfPage(21)).toBe(10)
    expect(halfPage(1)).toBe(1)
    expect(halfPage(0)).toBe(1)
  })
})

describe("modified", () => {
  test("ctrl and meta combinations are not letter bindings", () => {
    // The bug this exists to prevent: ^p reached `case "p"` (replay) in the message table
    // while App opened the palette on the same keystroke — two handlers, one key.
    expect(modified(normalizeKey({ name: "p", ctrl: true }))).toBe(true)
    expect(modified(normalizeKey({ name: "p", meta: true }))).toBe(true)
  })

  test("plain and shifted letters still are", () => {
    expect(modified(normalizeKey({ name: "p" }))).toBe(false)
    expect(modified(normalizeKey({ name: "R", shift: true }))).toBe(false)
    // Shift alone must stay a binding: shift+R commits a replay.
    expect(modified(normalizeKey({ name: "r", shift: true }))).toBe(false)
  })

  test("the nav helpers claim their ctrl keys before the guard is reached", () => {
    for (const name of ["n", "p"]) {
      expect(listNav(normalizeKey({ name, ctrl: true }))).not.toBeNull()
    }
    for (const name of ["d", "u"]) {
      expect(pageNav(normalizeKey({ name, ctrl: true }))).not.toBeNull()
    }
  })
})
