<!-- okf
type: Reference
title: "@namzu/cli"
description: >-
  A terminal coding agent built on the Namzu kernel, from the same public API
  you get. Interactive sessions, headless runs that stream structured events,
  and a doctor that reports what the host can actually do.
tags: [readme, package, cli, agent]
timestamp: 2026-08-20T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/cli</h1>

**A terminal coding agent, built on [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk).**

[![npm](https://img.shields.io/npm/v/@namzu/cli.svg)](https://www.npmjs.com/package/@namzu/cli)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Headless](#headless-runs) · [Documentation](#documentation)

</div>

---

A terminal coding agent built entirely on the Namzu kernel, in the same
repository, from the same public API you get. It exists as much to prove the
kernel as to be used: every gap in the SDK showed up first as something the CLI
had to work around.

## Install

```bash
npm install -g @namzu/cli     # the binary
npx @namzu/cli                # or run it once without installing
```

Requires Node.js 20+.

There is also an installer, which checks the Node version, installs the package
and then verifies the binary answers before claiming success. If the global
prefix is not writable it retries into `~/.namzu` and names the one line to add
to your profile; it never re-runs itself with elevated privileges.

```bash
curl -fsSL https://raw.githubusercontent.com/cogitave/namzu/main/install.sh | sh
# Windows
irm https://raw.githubusercontent.com/cogitave/namzu/main/install.ps1 | iex
```

Installing brings the kernel and five model drivers — Anthropic, OpenAI,
DeepSeek, OpenRouter and Ollama — plus `@namzu/files`, as ordinary dependencies
rather than peers. So a fresh install can already reach any of those services, given a
credential. `@namzu/telemetry`, `@namzu/sandbox` and `@namzu/computer-use` are
**not** installed with it; they are the optional capabilities `namzu doctor`
probes for.

## Usage

```bash
namzu                       # interactive session in the current directory
namzu doctor                # what this host can actually do, and what is missing
namzu login                 # store a credential in the vault
```

Repository policy stays live for the whole session. The CLI starts with the
applicable `AGENTS.md` chain, discovers nested instruction files after
successful reads, writes and edits, and labels every file with its directory
scope. The current snapshot is retained in durable model context, while a
resumed session uses its validated project-relative paths to re-read the files
from disk instead of trusting stale saved prose.

## Headless runs

```bash
namzu run "fix the failing test" --format json
namzu run-stream "refactor the parser" | jq -c 'select(.type == "tool_call")'
```

`run` prints a result; `run-stream` emits one structured event per line as the
run happens, so a script can act on a tool call before the run is over. Both
take `--verbose`/`--quiet`, and both write logs to stderr so stdout stays a
clean protocol stream.

The interactive transcript also shows provider capability mismatches and
tool-history repairs before the affected answer. A history warning reports the
source and measured rewrite counts without echoing tool content, and tells the
operator to verify external state before retrying a non-idempotent interrupted
call.

## Documentation

- [The operator application](https://github.com/cogitave/namzu/blob/main/docs/cli/reference.md) — every command, the configuration surface, headless event shapes
- [`namzu doctor`](https://github.com/cogitave/namzu/blob/main/docs/cli/doctor.md)
- [All docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
