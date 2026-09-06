#!/usr/bin/env bun
/* eslint-disable no-console -- build script: progress output is the point */

/**
 * Build the standalone binary — for this machine by default, for every supported
 * platform with `--all`, or for one platform when CI sets BUILD_TARGET_OS/ARCH.
 *
 * A plain `bun build --compile` produces a binary in which nothing is syntax-highlighted:
 * OpenTUI highlights through a tree-sitter worker, and `new Worker(…)` inside a dependency
 * is not something the bundler can follow, so the worker is missing from the binary and
 * every highlight fails silently. The worker is therefore passed as a second entrypoint,
 * and OpenTUI is handed the path it will live at inside the binary through the
 * compile-time constant it reads.
 *
 * This file is generated from candril/homebrew-tap/templates/build.ts; edit it there.
 */

import { basename, relative, resolve } from "node:path"
import { realpathSync } from "node:fs"
import { $ } from "bun"

interface Target {
  os: "darwin" | "linux"
  arch: "arm64" | "x64"
}

const ALL_TARGETS: Target[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
]

const projectDir = resolve(import.meta.dir, "..")
process.chdir(projectDir)

const buildAll = Bun.argv.slice(2).includes("--all")
const envOs = process.env["BUILD_TARGET_OS"] as Target["os"] | undefined
const envArch = process.env["BUILD_TARGET_ARCH"] as Target["arch"] | undefined

const targets: Target[] =
  envOs && envArch
    ? [{ os: envOs, arch: envArch }]
    : buildAll
      ? ALL_TARGETS
      : ALL_TARGETS.filter((t) => t.os === process.platform && t.arch === process.arch)

if (targets.length === 0) {
  console.error(`no build target for ${process.platform}/${process.arch}`)
  process.exit(1)
}

const workerPath = realpathSync(resolve(projectDir, "node_modules/@opentui/core/parser.worker.js"))
// Bun lays an entrypoint down at its path relative to the project root; the bunfs root
// is the same on every platform built here (no Windows target).
const workerInBinary = `/$bunfs/root/${relative(projectDir, workerPath).replaceAll("\\", "/")}`

/**
 * The version stamped into the binary. A tag build reports the tag alone: the release is
 * named by the tag, and package.json would disagree with it the moment either drifts
 * (`just release` checks them against each other before tagging). Any other build keeps
 * the short commit, which is the only way to tell two dev binaries apart.
 */
async function stampedVersion(): Promise<string> {
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

const version = await stampedVersion()
await $`mkdir -p dist`

// A local single-target build is what `just install-bin` copies, so it is plain
// `dist/topiq`; CI and `--all` builds carry the platform in the name. (Copying the
// file afterwards is not an option: macOS refuses to run the copy of a compiled binary
// until it is re-signed.)
const localBuild = targets.length === 1 && !envOs

for (const target of targets) {
  const outfile = localBuild ? "dist/topiq" : `dist/topiq-${target.os}-${target.arch}`
  console.log(`topiq ${version} → ${outfile}`)
  const result = await Bun.build({
    entrypoints: ["./src/index.tsx", workerPath],
    target: "bun",
    compile: { target: `bun-${target.os}-${target.arch}`, outfile },
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
}

console.log(`  worker: ${basename(workerPath)} at ${workerInBinary}`)
console.log("done")
