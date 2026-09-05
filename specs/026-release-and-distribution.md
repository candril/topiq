# Release & Distribution

**Status**: In Progress

## Description

topiq is a single compiled binary, so distribution is: build one per platform, publish
them under a tag, and give people a one-line way to fetch the right one. Until this spec
there was no way to get topiq other than cloning the repo and running `just build`, which
rules out everyone who does not already have Bun.

The shape is the one [`monq`](../../monq) proved: a tag push builds a matrix of binaries on
**native runners**, uploads them gzipped to a GitHub Release alongside `SHA256SUMS`, and a
`curl | bash` installer resolves the latest tag, verifies the checksum and drops the binary
on `$PATH`. Package managers (Homebrew, Nix) layer on top of the same release assets —
they are consumers of this spec, not alternatives to it.

Publishing is also what forces the repo to be publishable: the working tree and every
example carry placeholder cluster identities, never a real broker, vault or service
account ([nfr/003](./nfr/003-security-and-credentials.md)).

## Capabilities

### P1 — Must Have

- **CI on every push and PR** — typecheck, lint, format check, and a build. A release
  should never be the first time the compile is exercised on Linux.
- **Tag-triggered release.** Pushing `v*` builds `darwin-{arm64,x64}` and
  `linux-{arm64,x64}`, each on a runner of that platform, and publishes one GitHub Release.
- **Native runners, not cross-compilation.** `bun build --compile` can cross-target, but
  building where the binary will run keeps the door open for a future native dependency and
  matches what actually gets tested. topiq has no native runtime dependency today
  (`kafkajs-snappy` → `snappyjs` is pure JS), so this is cheap insurance, not a fix.
- **Gzipped assets + `SHA256SUMS`.** Named `topiq-<os>-<arch>.gz` so an installer can
  compute the asset name from `uname` alone.
- **A released binary reports its tag.** `topiq --version` must print `0.2.0` for `v0.2.0`,
  not the `package.json` version plus whatever commit the runner checked out
  ([001](./001-app-shell.md) owns the flag; this spec owns what it says in a release).
- **`scripts/install.sh`** — detect os/arch, resolve the latest release (or honour
  `TOPIQ_VERSION`), download, **verify the checksum**, install to `TOPIQ_INSTALL_DIR`
  (default `/usr/local/bin`), `sudo` only when the target is not writable.
- **The installer replaces the file, never writes through it.** `mv` onto the target, so
  the inode changes; overwriting in place leaves macOS with a cached code signature that no
  longer matches the contents and it SIGKILLs the binary — exit 137, no output, looks
  exactly like a hang. Same reason `just install-bin` uses `install`.
- **`CHANGELOG.md`**, Keep-a-Changelog shaped, one `## [x.y.z]` section per release. The
  release job lifts that section into the release notes, so an unwritten entry is a visibly
  empty release rather than a silent one.

### P2 — Should Have

- **A Homebrew tap** (`candril/homebrew-tap`, `Formula/topiq.rb`) pinning the four release
  assets by sha256, bumped by a release job. A tap, not homebrew-core: core wants
  build-from-source and notability, and a compiled Bun blob has neither.
- **A flake** (`flake.nix`) wrapping the same assets — `fetchurl` + install, with
  `autoPatchelfHook` and `stdenv.cc.cc.lib` on Linux, since a Bun binary links glibc and
  libstdc++ rather than being static. `nix run github:candril/topiq` with no clone.
- **A README that installs.** The three routes above, in the order most people will use.

### P3 — Nice to Have

- A docs site (Astro/Starlight on GitHub Pages), as monq has.
- Prerelease handling: a tag containing `-` marks the GitHub Release as a prerelease.
- Windows. OpenTUI's terminal assumptions are unverified there; nothing about the release
  shape forbids it once someone checks.

## Out of Scope

- **nixpkgs.** A real PR, a maintainer commitment, and reviewers who will (fairly) ask why
  a prebuilt binary rather than a source build. Revisit when there are users.
- **npm publish.** `bin` points at `dist/topiq`, which is not in the package; publishing to
  npm would mean a postinstall download, which is a worse installer than the installer.
- **Code signing / notarisation.** The binaries are ad-hoc signed by Bun. Gatekeeper does
  not quarantine a `curl`-fetched file (no LaunchServices involved), so this only matters
  the day topiq ships a `.app` or a `.dmg`.
- **Auto-update.** A tool that rewrites its own binary is a support burden; `brew upgrade`
  and re-running the installer are enough.

## Technical Notes

- `scripts/build.ts` already takes the output path as `argv[2]`, so the matrix passes
  `dist/topiq-<os>-<arch>` directly — no `BUILD_TARGET_*` env indirection (monq needed it
  because its build script derived the name itself).
- Version stamping lives in `topiqVersion()`: prefer `GITHUB_REF_NAME` when it looks like a
  tag, else fall back to `package.json` + short commit for local builds. The value is
  baked in via `--define TOPIQ_VERSION`, read by `src/version.ts`.
- The release job needs `contents: write`; nothing else. The tap bump (P2) needs a PAT,
  because `GITHUB_TOKEN` cannot push to another repository.
- Release notes are extracted from `CHANGELOG.md` with awk, matching `## [<version>]` and
  printing until the next `## [`.
- The installer's checksum step prefers `shasum -a 256` on macOS and `sha256sum` on Linux,
  and fails loudly if neither exists — a silent skip is how a corrupted download becomes a
  mystery bug report.

## Invariants

None of the three data invariants ([nfr/006](./nfr/006-data-fidelity.md)) are touched — no
byte on a message path goes near this. The one thing a release *can* corrupt is the binary
itself, which is what `SHA256SUMS` and the verify step exist for.

## File Structure

| File | Change |
|------|--------|
| `.github/workflows/ci.yml` | New — typecheck, lint, fmt, build on push/PR |
| `.github/workflows/release.yml` | New — `v*` tag → matrix build → GitHub Release |
| `scripts/install.sh` | New — `curl \| bash` installer with checksum verification |
| `scripts/build.ts` | Version stamping prefers the release tag |
| `CHANGELOG.md` | New — release notes source |
| `LICENSE` | New — MIT, matching `package.json` |
| `README.md` | New — what topiq is, and the install routes |
| `justfile` | `release` recipe: guard, tag, push |

## Open Questions

- **Where does the tap live?** `candril/homebrew-tap` shared with monq and lane, or one tap
  per tool? Shared is less to maintain and `brew tap candril/tap` once covers all three;
  resolve when the second tool actually ships a formula.
- **Does the release need a Linux smoke run?** CI builds on Linux but never *runs* the TUI
  there. A headless `--version` invocation is nearly free and would catch a broken
  bundle; a real render test needs a pty harness that does not exist yet.
