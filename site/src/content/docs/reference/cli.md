---
title: CLI
description: topiq's handful of arguments and flags.
---

Most of topiq is the TUI. The command line is deliberately thin.

## `topiq [cluster] [topic]`

```sh
topiq                                # the cluster picker
topiq orders-test                    # connect to a profile
topiq orders-test orders.placed.v2   # …and open a topic
```

`cluster` is a profile name from `~/.config/topiq/config.toml`. An unknown name lists the
configured ones and exits 1. The connection happens *after* the first paint — `password_cmd`
can take seconds, and a terminal that stays blank that long reads as a hang.

## `--demo`

```sh
topiq --demo                         # demo-test, the writable profile
topiq --demo demo-prod               # the same cluster with writes off
topiq --demo demo-test orders.placed.v2
```

An offline cluster that exists only in memory: three topics of a fictional shop, real Avro
schemas behind real Confluent framing, keys above 2^53, a tombstone, one message with an
unregistered schema id, three consumer groups (one seekable, one that refuses, one with
undefined lag), and a producer that adds a message every 1.5 s while you follow. No config is
read; no network is touched. **Writes work** and are forgotten on exit.

The header says `demo · nothing here is real` the whole time.

Good for trying the keymap, for working on topiq itself, and for the docs screenshots.
`TOPIQ_DEMO_EPOCH` pins the clock, `TOPIQ_DEMO_LATENCY=0` removes the simulated delays.

## `--version`, `-v`

```sh
topiq --version
```

A released binary prints its tag (`0.1.0`); a local build prints the `package.json` version
plus the commit (`0.1.0+1f69c10`).

## `--help`, `-h`

## Development

From a clone, with [just](https://github.com/casey/just):

| Recipe | What |
| --- | --- |
| `just run <profile> [topic]` | run once against a real cluster |
| `just dev` | run with hot reload |
| `just demo` | run against the demo cluster |
| `just test` | `bun test` |
| `just check` | typecheck + lint + fmt-check |
| `just build` / `just install-bin` | compile `dist/topiq` / install it to `~/.local/bin` |
| `just smoke <profile> <topic>` | live consume against a real cluster from your config |
| `just shots` / `just demo-gif` | regenerate the docs screenshots / the README gif from the demo |
| `just release <version>` | check, then tag `v<version>`; pushing the tag builds and publishes |
| `just site-dev` / `just site-build` | the docs site |
