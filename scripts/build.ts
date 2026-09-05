#!/usr/bin/env bun
/* eslint-disable no-console -- build script: progress output is the point */

/**
 * Build the standalone binary.
 *
 * The OpenTUI tree-sitter worker is passed as a second **entrypoint** and its in-binary
 * path handed to OpenTUI through the compile-time constant it reads. `new Worker(…)`
 * inside a dependency is not something the bundler can follow, so without this any
 * syntax-highlighted view renders as raw text in the compiled binary (lane hit this
 * first). topiq does not highlight anything today; the wiring stays so that the day it
 * does, the binary is not silently wrong.
 */

import { basename, relative, resolve } from "node:path"
import { realpathSync } from "node:fs"

const projectDir = resolve(import.meta.dir, "..")
process.chdir(projectDir)

const outfile = Bun.argv[2] ?? "dist/topiq"

const workerPath = realpathSync(resolve(projectDir, "node_modules/@opentui/core/parser.worker.js"))
const workerInBinary = `/$bunfs/root/${relative(projectDir, workerPath).replaceAll("\\", "/")}`

/** Stamped in so a released binary reports its own version rather than shelling out to
 *  git at startup and reporting whichever repo it happens to be run from.
 *
 *  A tag build reports the tag alone: the release is named by the tag, and `package.json`
 *  plus the runner's commit would disagree with it the moment either drifts (spec 026).
 *  Local builds keep the commit — that is the only way to tell two dev binaries apart. */
async function topiqVersion(): Promise<string> {
  const tag = process.env["GITHUB_REF_NAME"]
  if (process.env["GITHUB_REF_TYPE"] === "tag" && tag?.startsWith("v")) {
    return tag.slice(1)
  }
  const { version } = (await Bun.file(resolve(projectDir, "package.json")).json()) as {
    version: string
  }
  const git = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  const commit = git.exitCode === 0 ? git.stdout.toString().trim() : ""
  return commit ? `${version}+${commit}` : version
}

const version = await topiqVersion()
console.log(`topiq ${version} → ${outfile}`)
console.log(`  worker: ${basename(workerPath)} at ${workerInBinary}`)

const result = await Bun.build({
  entrypoints: ["./src/index.tsx", workerPath],
  target: "bun",
  compile: { outfile },
  define: {
    OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(workerInBinary),
    TOPIQ_VERSION: JSON.stringify(version),
  },
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log("done")
