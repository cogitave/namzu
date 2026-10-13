---
type: Reference
title: Startup time
description: What Namzu does before the first screen or the first request, what was made lazy and why, the compile cache, how `exec` treats piped input, and the benchmark that measures all of it.
resource: scripts/bench-startup.mjs
tags: [cli, performance, startup, benchmark]
status: stable
generated: { by: process:claude-code, at: 2026-10-13T00:00:00Z }
---

# Startup time

Most of a launch is loading code, not running it. Before this was worked on,
`namzu --version` read and compiled about 1,150 modules (10 MB of JavaScript)
to print one line, and the terminal and `namzu exec` compiled the browser
engine and the sandbox before they knew whether anyone would use them. This
page lists what changed, what to expect, and how to measure it yourself.

## What loads, and when

| Command | Loads |
|---|---|
| `namzu --version`, `namzu --help` | The command line parser and the list of commands (about 26 modules). Not the SDK, not any command. |
| `namzu <command>` | The command's own module, and the SDK, when the command is asked for. `namzu <command> --help` loads the command, because most commands print their own help. |
| `namzu`, `namzu resume` | The terminal screens and the SDK. |
| `namzu exec` | The same as any command. |

The root `--help` and every subcommand's `--help` print the same text as
before; only where they get their words from changed. The list of commands
(name, aliases, one-line description, and whether the command parses its own
options) lives in `packages/cli/src/commands/manifest.ts`, and
`commands/__tests__/lazy-commands.test.ts` fails when an entry differs from the
command it stands for.

## Optional packages are checked on disk

At launch the terminal and `exec` write a line saying which optional packages
are installed (`@namzu/sandbox`, `@namzu/files`, `@namzu/computer-use`,
`@namzu/browser`, `@namzu/telemetry`). That check now finds each package's
folder and reads its manifest; it no longer imports the package, which is what
used to compile the browser engine and the telemetry stack on every launch.

Two consequences. A package that is installed but cannot load is no longer
reported at launch (the `namzu.capability.broken` record); it is found where it
is first used, and `namzu doctor` still imports each package and reports it.
And `@namzu/browser` loads `playwright-core` when a browser is first launched,
not when the package is imported.

## The compile cache

Node can keep the compiled form of a module on disk and reuse it on the next
launch. Namzu turns that on with `module.enableCompileCache` (Node 22.1 and
later; the CLI requires 22.13) as the first thing `bin.js` does, so every
module loaded after it is covered.

- The cache is `cache/compile` inside the Namzu home (`~/.namzu`, or
  `NAMZU_HOME`). It is used only when that folder already exists (a link to a
  folder counts): a wrong `NAMZU_HOME` is never created for it.
- It is keyed by the module's content and Node's version, so an upgrade or a
  rebuild never loads stale code, and Node discards an entry it cannot read.
  Deleting the folder is always safe.
- It never stops a launch. A read-only home, a full disk, an older Node or an
  unsupported file system leave the launch running uncached.
- Node's own switches win: `NODE_DISABLE_COMPILE_CACHE=1` turns it off, and
  `NODE_COMPILE_CACHE=<dir>` chooses the directory (Namzu then does nothing,
  because Node has already enabled it). The first launch after an install or
  an upgrade fills the cache and is a little slower; later ones are faster.
- Windows: the Node documentation for this function names no platform
  exception, and the code does nothing platform-specific. It has been measured
  on Linux only; if a Windows file system refuses the folder, the launch runs
  uncached.

## Piped input to `exec`

`cat file | namzu exec "summarise this"` appends the piped text to the question.
Because "is anything being piped in" cannot be answered without reading (an
idle pipe, a pipe with data and a test runner's stdin look the same to the
operating system), `exec` waits a quarter second for the first byte when a
prompt argument is given. Input that starts in that time is read to the end,
however long it takes; `exec` with no prompt argument, or with `-`, waits for
the pipe as long as it takes.

That rule did not change. What changed is that the quarter second no longer
adds to the startup: the read starts at the same point and its deadline runs
from the same point, but the rest of the startup carries on while it runs, and
the piped text is added to the question just before it is sent. A pipe nobody
writes to (a CI step, a script that keeps stdin open) therefore costs close to
nothing extra instead of 250 ms. Two cases still wait before continuing,
because the text can change what happens next: a prompt that starts with `/`
(the piped text could change which command it names) and a missing prompt
argument.

Only that quarter second is promised. A producer that is slower to write its
first byte (a `curl` to a slow host) may or may not be caught, depending on how
busy the rest of startup is. Put the text in the prompt, or make sure the
producer writes promptly, if you depend on it.

`exec --json` still reads its optional history from stdin before it opens the
session, and still waits the quarter second there.

## Tools that cannot work are not sent

The first model request is mostly tool schemas (about 74% of 16k tokens in the
terminal). A tool that can only refuse is mounted in the session, so `/tools` and
the notices still name it, but it is *suspended* (`readyWhen`) and its schema is
left out of every request until it can work:

| Tool | Not sent when | Sent again when |
|---|---|---|
| `computer_use` | the provider cannot return images in tool results, the desktop host failed to start, or the host reports no control (screenshot, mouse, keyboard, clipboard, windows) | the host reports a control |
| `browser`, `browser_act` | the browser has no usable engine here | a profile switch or release finds one |
| `list_pals`, `send_pal_message` | the owner has no Pals registry | one exists |

Tools that work are untouched: nothing is shortened and the system prompt is
unchanged. Measured with the benchmark's fake server on a machine with no
vision-capable provider and no Pals, the terminal's first request went from 40
tools and 78,428 bytes (16,980 o200k tokens) to 37 tools and 73,149 bytes
(15,827 tokens), and `exec` from 29 to 27 tools and 52,904 to 51,666 bytes. A
machine whose browser cannot run drops the two browser tools as well (35 tools,
69,137 bytes).

## Measuring it

```
pnpm -r build
node scripts/bench-startup.mjs --runs 7
```

`scripts/bench-startup.mjs` measures, against a fake model server on the
loopback interface (no real model is called):

| Metric | Meaning |
|---|---|
| `version ms`, `help ms` | Spawn to exit of `namzu --version` and `namzu --help`. |
| `tui first byte ms` | Spawn to the first byte on the pseudo-terminal. |
| `tui first frame ms` | Spawn to the composer box. |
| `tui ready ms` | Spawn to a composer that accepts typing, in a trusted folder. |
| `exec request ms (stdin tty / pipe / null)` | `namzu exec hello`, spawn to the request reaching the server, with stdin a terminal, an open pipe nobody writes to, and `/dev/null`. |
| `modules at --version`, `modules at tui first frame` | ES modules loaded, counted by a loader hook in a separate run. |
| `peak rss kB` | Peak resident memory of the process (Linux, from `/proc`). |

Every run gets a fresh `HOME` and `NAMZU_HOME` under `--work` (a temporary
directory by default), with `WSL_DISTRO_NAME`, `WSL_INTEROP` and `CI` unset and
`/mnt/*` removed from `PATH` (`--no-strip-mnt` keeps it). The compile cache
directory is a link to one shared folder, as a person's cache outlives a launch;
`--cold-cache` gives every run an empty one. Options: `--runs N`, `--build
<bin.js>` (compare two builds), `--only version,help,tui,exec`, `--out
<file.json>`. The interactive screen needs `node-pty` from `@namzu/cli`. Each
metric is reported as median and range over the runs, after one warm-up run.
Nothing in CI runs it yet.

### Reference numbers

Measured on WSL2 (Node 24.19), median of 7, warm file cache. Your numbers will
differ; the point is the proportions.

| Metric | Before | After | After, first run (cold compile cache) |
|---|---|---|---|
| `namzu --version` | 484 ms | 53 ms | 48 ms |
| `namzu --help` | 487 ms | 49 ms | |
| Modules at `--version` | 1,154 | 26 | 26 |
| Terminal, first byte | 650 ms | 483 ms | 660 ms |
| Terminal, first frame | 704 ms | 535 ms | 713 ms |
| Terminal, ready | 1,102 ms | 655 ms | 850 ms |
| `exec` to request, stdin a terminal | 996 ms | 589 ms | |
| `exec` to request, stdin an idle pipe | 1,254 ms | 666 ms | |
| `exec` to request, stdin `/dev/null` | 991 ms | 579 ms | |

What is left is mostly the SDK barrel (`@namzu/sdk` is one entry point of about
235 exports, about 250 ms to load) and the terminal's own screens. The SDK has
no narrower entry points yet, so the terminal and every command that runs still
load all of it.
