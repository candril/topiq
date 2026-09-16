import { afterEach, describe, expect, test } from "bun:test"
import { captureWarnings, type WarningEntry } from "./warnings.ts"

const restores: (() => void)[] = []
afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore()
  }
})

/** Warnings are delivered a tick after they are raised, by the runtime's own scheduling —
 *  asserting synchronously would only ever see an empty log. */
const settle = (): Promise<void> => Bun.sleep(1)

describe("captureWarnings (nfr/002)", () => {
  test("the runtime's printing listener is gone while captured, and back afterwards", () => {
    const before = process.listeners("warning")
    const restore = captureWarnings(() => {})
    expect(process.listeners("warning")).toHaveLength(1)
    restore()
    expect(process.listeners("warning")).toEqual(before)
  })

  test("a warning reaches the log with its name, message and stack", async () => {
    const entries: WarningEntry[] = []
    restores.push(captureWarnings((entry) => entries.push(entry)))
    process.emitWarning("-1789568820064 is a negative number", "TimeoutNegativeWarning")
    await settle()

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: "WARN",
      namespace: "process",
      name: "TimeoutNegativeWarning",
      message: "-1789568820064 is a negative number",
    })
    expect(typeof entries[0]!["stack"]).toBe("string")
  })
})

describe("the reported failure, end to end", () => {
  // Fresh processes throughout: the runtime prints TimeoutNegativeWarning once per process,
  // so asserting silence only means something where nothing has consumed it yet. The
  // trigger is the shape of the kafkajs request-queue bug — `throttledUntil` at -1, minus
  // the clock, straight into setTimeout.
  const NEGATIVE_TIMEOUT = `setTimeout(() => {}, -1 - Date.now())`

  async function run(source: string): Promise<{ stderr: string; code: number }> {
    const proc = Bun.spawn(["bun", "-e", source], { stderr: "pipe", stdout: "pipe" })
    const stderr = await new Response(proc.stderr).text()
    return { stderr, code: await proc.exited }
  }

  const capturing = (sink: string): string => `
    const { captureWarnings } = await import("${import.meta.dir}/warnings.ts")
    captureWarnings(${sink})
    ${NEGATIVE_TIMEOUT}
  `

  test("uncaptured, it prints onto whatever is on the terminal", async () => {
    const { stderr } = await run(NEGATIVE_TIMEOUT)
    expect(stderr).toContain("TimeoutNegativeWarning")
  })

  test("captured, it prints nothing at all", async () => {
    const { stderr, code } = await run(capturing("() => {}"))
    expect(stderr).toBe("")
    expect(code).toBe(0)
  })

  test("a sink that throws stays silent too, and does not take the process down", async () => {
    const { stderr, code } = await run(
      capturing(`() => { throw new Error("the log file went away") }`),
    )
    expect(stderr).toBe("")
    expect(code).toBe(0)
  })
})
