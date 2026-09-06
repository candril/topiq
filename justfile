# Default recipe - show available commands
default:
    @just --list

# Run the TUI application (e.g. just run orders-test [topic])
run *args:
    bun src/index.tsx {{args}}

# Run with hot reload
dev *args:
    bun --watch src/index.tsx {{args}}

# Install dependencies
install:
    bun install

# Run tests
test:
    bun test

# Type check without emitting
typecheck:
    bun run typecheck

# Run all checks: typecheck + lint + fmt
check:
    just typecheck
    just lint
    just fmt-check

# Lint source files
lint:
    bun run lint

# Lint and auto-fix
lint-fix:
    bun run lint:fix

# Format source files
fmt:
    bun run fmt

# Check formatting without writing
fmt-check:
    bun run fmt:check

# Build the standalone binary into dist/
build:
    bun run build

# Build and install it to ~/.local/bin (on PATH, like lane and monq)
#
# `rm` first, deliberately: copying over the existing file keeps the inode, and macOS
# kills a running binary whose cached code signature no longer matches its contents —
# silently, with exit 137 and no output. `install` replaces the inode for the same reason.
install-bin: build
    mkdir -p ~/.local/bin
    install -m 755 dist/topiq ~/.local/bin/topiq
    @~/.local/bin/topiq --version >/dev/null || (echo "installed binary does not run" && exit 1)
    @echo "installed: ~/.local/bin/topiq $(~/.local/bin/topiq --version)"

# Tag a release: just release 0.2.0 (pushing the tag is what builds and publishes it)
#
# The tag is the version a released binary reports, so package.json and CHANGELOG.md are
# checked against it here rather than after four runners have already built the wrong
# number (spec 026). jj cannot create git tags, and a bookmark is a branch, not a tag —
# hence plain `git tag` against the colocated repo, where HEAD tracks `@-`.
release version:
    @grep -q '"version": "{{version}}"' package.json || (echo "package.json is not {{version}}" && exit 1)
    @grep -q '^## \[{{version}}\]' CHANGELOG.md || (echo "CHANGELOG.md has no [{{version}}] section" && exit 1)
    @test -z "$(jj diff --name-only)" || (echo "working copy has uncommitted changes" && exit 1)
    just check
    just test
    git tag v{{version}}
    @echo "tagged v{{version}} at $(git rev-parse --short HEAD)"
    @echo "publish it with: git push origin v{{version}}"

# Run the offline demo cluster (spec 027) — no config, no broker, writes stay in memory
demo *args:
    bun src/index.tsx --demo {{args}}

# Open the demo for screenshots: isolated state, fixed version label, pinned clock
shot:
    XDG_CACHE_HOME=/tmp/topiq-shot/cache XDG_STATE_HOME=/tmp/topiq-shot/state \
    XDG_CONFIG_HOME=/tmp/topiq-shot/config TOPIQ_DEMO_EPOCH=$(date -u +%Y-%m-%dT%H:00:00Z) \
    bun --define 'TOPIQ_VERSION="0.1.0"' src/index.tsx --demo

# Take every docs screenshot from the demo cluster, unattended (tmux + python3/Pillow)
shots *names:
    bash scripts/shots.sh {{names}}

# Record the README demo gif from the demo cluster, unattended (tmux + python3/Pillow)
demo-gif:
    bash scripts/demo.sh

# Run the documentation site locally
site-dev:
    cd site && bun run dev

# Build the documentation site
site-build:
    cd site && bun run build

# Live smoke test against a real cluster: just smoke <profile> <topic> [n] (needs az login)
#
# Profile, topic and CA all come from ~/.config/topiq/config.toml — the repo is public and
# holds no cluster identity of its own.
smoke profile topic n="10":
    bun run spike/consume.ts {{profile}} {{topic}} {{n}}
