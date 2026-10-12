---
type: Reference
title: namzu computer
description: Check, set up and stop the Windows computer Pals run on, in plain words for people and as stable JSON lines for Namzu Desktop.
resource: packages/cli/src/computer
tags: [cli, computers, windows, setup, json]
status: draft
---

# namzu computer

On Windows a Pal's computer runs on Microsoft's Linux container support, as
Namzu's own light Linux. `namzu computer` checks whether this PC is ready,
sets up what is missing after the person agrees, and stops the Linux machine
when nothing uses it. It is a front for
[`@namzu/sandbox/local-virtual-computer/setup`](../sdk/local-pal-computer.md#setting-up-a-windows-pc);
the agent runtime never calls it, so a model cannot cause an install.

```bash
namzu computer status [--json] [--bundle <dir>]
namzu computer setup  [--json] [--plan <id>] [--yes] [--bundle <dir>]
namzu computer stop-idle [--json]
```

The image ships inside the Namzu installer. `--bundle <dir>` (or
`NAMZU_PAL_COMPUTER_BUNDLE`) names the folder that holds `manifest.json` and
the archive beside it; Namzu Desktop sets it to `resources/pal-computer`. The
image reference is the manifest's `imageRef`, else `namzu-local-computer:2`.
With `NAMZU_PAL_COMPUTER_ENGINE=wslc`, no `NAMZU_PAL_COMPUTER_IMAGE` and a
bundle, the Pal runtime uses that same `imageRef`; an explicit image wins.

## What people see

`status` prints one sentence, for example "This PC is ready for Pal computers.",
"Windows needs to add Linux support once (about 350 MB). Run namzu computer
setup.", or "This PC has virtualization switched off. Turn on Intel VT-x or
AMD-V in the PC's startup settings, then run namzu computer status again."
Sizes and times are rounded for reading; codes and engine output never appear.
Off Windows it says "Pal computers on this system use Docker or Podman. Setup is
automatic only on Windows."

`setup` prints what it will install, the download size, about how long it
takes, whether Windows will ask permission (at most once per plan; the sentence says when it will not) and whether
a restart may be needed, then asks `Continue? [y/N]`. It runs with one progress
line per step and ends with a sentence. Windows' own permission prompt cannot
be skipped. A blocked plan (policy, virtualization off, unsupported, update
needed, image missing from this copy) prints its sentence and exits 69.

| Exit | Meaning |
|---|---|
| 0 | Done, nothing to do, restart needed (said in words), or the person answered no |
| 1 | Setup ran and did not finish, was declined at Windows' prompt, or the plan changed |
| 64 | The arguments are wrong, or `--bundle` has no readable `manifest.json` |
| 69 | Nothing Namzu can do here (blocked plan, or not Windows) |
| 70 | The check itself failed |
| 75 | No terminal to answer `Continue?` and neither `--yes` nor `--plan` was given; the plan was printed |

## JSON for Namzu Desktop

`--json` prints one JSON object per line and never prose. Every object carries
`"version": 1`; the version rises only when a field is renamed or removed.
Types are those of the setup contract (`WslcReadiness`, `WslcSetupPlan`,
`WslcSetupProgress`, `WslcSetupResult`).

```jsonc
// status --json: one line
{"version":1,"readiness":{ "state":"wsl-missing", "...":"..." },"plan":{ "id":"...", "steps":[], "...":"..." }}

// setup --json --plan <id>: progress lines, then one result line
{"version":1,"progress":{"step":"download-wsl","phase":"started"}}
{"version":1,"progress":{"step":"download-wsl","phase":"progress","done":1048576,"total":367001600,"unit":"bytes"}}
{"version":1,"result":{"outcome":"restart-required"}}

// stop-idle --json: one line
{"version":1,"outcome":"stopped"}   // or "busy" or "not-running"

// setup --json off Windows (exit 69)
{"version":1,"result":{"outcome":"blocked","blocked":"unsupported"}}

// an argument or check failure: one line
{"version":1,"error":{"code":"plan-required"}}
{"version":1,"error":{"code":"check-failed"}}      // the check itself failed
{"version":1,"error":{"code":"bundle-unreadable"}} // --bundle has no readable manifest
```

`setup --json` requires `--plan <id>`: the id of a plan the caller showed and
the person accepted, taken from `status --json`. The CLI stamps `approvedAt` as
now. The run refuses a plan that no longer matches the machine and answers
`{"result":{"outcome":"plan-changed","plan":{...}}}` (exit 1). Its exit code
follows the result: 0 for `ready` and `restart-required`, 69 for `blocked`, 1
for the rest. Without `--plan` it prints the `plan-required` error and exits 64.

## When the engine or image is missing

On Windows, a Pal computer that cannot start because Linux support or the image
is missing ends its message with "Run namzu computer setup to set this up."
Which message is chosen by the sandbox's setup `code` (`engine-missing`,
`engine-too-old`, `image-missing`), never by matching the sandbox's wording; the
words are Namzu's own ("Linux container support is not installed on this PC.",
"Linux container support on this PC is too old for Namzu.", "The Pal computer is
not set up on this PC yet."). The model is told only "The computer is not set up; the person can set it up
from Namzu." The hint applies to the `wslc` engine's messages only; with the Docker or Podman engine on Windows the message keeps its own build instruction. Other setup failures that Namzu cannot fix (policy, virtualization,
an update) keep their own sentence.

When a restart has to come first, `setup` prints "Restart your PC to finish
setting up Pal computers." and exits 0 without asking to continue; the rest of
the plan (loading the image) waits for that restart. A failed setup ends with the
sentence for what failed and a `Details:` line that is a sentence too, with the
Windows error number when Windows gave one ("Windows reported a problem while
installing Linux support. Windows error 1603."), never the internal code. The
`--json` result keeps the code, a plain `detail` and `exitCode`.

Ctrl-C, Ctrl-D or a closed terminal at `Continue?` count as no: `Nothing was changed.` and exit 0. Off Windows `stop-idle` says there is no Linux machine to stop.
