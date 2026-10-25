---
type: Reference
title: Permission modes
description: The six modes a Namzu session can run in (prompt, accept-edits, plan, bypass, auto, strict), the flags and Shift+Tab that reach them, which two need an opt-in, what each still stops for, the permissions settings that choose or shut them, how the auto classifier picks its model, and what Desktop and sub-agents do with them.
resource: packages/cli/src/permissions/mode.ts
tags: [cli, permissions, modes, bypass, auto, classifier]
status: stable
generated: { by: process:claude-code, at: 2026-10-22T00:00:00Z }
---

# Permission modes

A mode decides what happens to a call that no rule decided. The `[permissions]` table says what a tool may do; a mode governs the rest, for one conversation. A mode can never reopen what a rule closed: a `deny` rule and the dangerous-pattern floor (`sudo`, `curl | sh` and the like are refused, not asked about) hold in every mode. The floor checks the command a shell tool is about to run (the `bash` or `monitor` command, or the whole input of a shell tool from a plugin or server); it does not read an agent prompt, a file being written or an edit, so text that only mentions `sudo` is not refused, and a delegated agent's own shell calls are checked when they run, and an `ask` rule is asked in every mode.

| Word | Reads as | Runs without a question | Still asks (or is refused when nobody can be asked) |
| --- | --- | --- | --- |
| `prompt` | the default | reads and the read-only shell commands | everything else |
| `accept-edits` | **Accept edits** | also `edit` and `write`, and `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` when every path they name is inside your folders | everything else; a catastrophic `rm` still asks |
| `plan` | **Plan (read-only)** | reads | any change is refused until you leave plan mode |
| `bypass` | **Bypass permissions** | everything below | the list under [What bypass and auto still ask](#what-bypass-and-auto-still-ask) |
| `auto` | **Auto** | what a second model allows | the same list, and what the classifier blocks |
| `strict` | **Preapproved tools only** | only calls a rule allows | nothing is asked: the rest is refused |

`strict` is the reference's `dontAsk`: for a run where nobody can be asked and every call must be pre-decided.

## Reaching a mode

| How | Mode |
| --- | --- |
| `--permission-mode prompt\|accept-edits\|plan\|bypass\|auto\|strict` | that mode, for this launch only |
| `--dangerously-skip-permissions`, `--yolo` | `bypass` (a `--permission-mode` given as well wins) |
| `--allow-dangerously-skip-permissions` | keeps the launch mode, but lets Shift+Tab and `/permissions` reach `bypass` |
| `/permissions` | a menu of every mode; only `strict` and the rules are under "More options" |
| `/permissions <word>` | that mode, for this conversation |
| `permissions.defaultMode` | the mode a launch starts in when no flag names one |
| Shift+Tab | the cycle below |

`--permission-mode auto` is the classifier. It used to mean "approve everything the gates did not stop", and that is now `bypass`; to keep the old no-prompt behaviour, use `--yolo` or `--permission-mode bypass`.

### The cycle

Shift+Tab walks `prompt`, `accept-edits`, `plan`, then `bypass` when it is available, then `auto` when it is available, then back to `prompt`. A door that is shut has no stop. `strict` is not on the cycle, and leaving it goes to `prompt`. It works mid-turn: the next decision of the running turn, and of its sub-agents, takes the new mode, and the footer is its only reply.

The footer names the mode: `⏵⏵ bypass permissions on` in red, `⏵⏵ auto mode on` in yellow, `⏵⏵ accept edits on`, `‖ plan mode on`, `‖ preapproved only on`.

The question before the screen opens when bypass starts (the one-time "Run without asking?") wraps on words at the terminal's width, and so does the red warning under the header while the mode is on. The permission box itself is described in [Terminal design](terminal-design.md): a write says whether it creates or replaces the file, and the answers keep their indent when one wraps.

## Which modes are available

**Bypass** is available only when the launch opened it: `--yolo`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypass`, or `permissions.defaultMode: bypass` in your own user file or the managed file. A project file cannot open it. `permissions.disableBypassMode: true` in any file shuts it for good, and a flag that names it is then an error (`Bypass mode is turned off by permissions.disableBypassMode in your configuration.`). Switching to bypass from inside a session when the launch did not open it is refused with a sentence that says how to start one that can.

**The first time** a person enters bypass, one question is asked: before the screen opens when the launch is in bypass (`Start in bypass mode? [y/N]`), or in the terminal when the switch is made from inside. The answer is kept in `~/.namzu/acknowledgements.json`; answering no leaves the session in the mode it was in.

**As root.** Bypass is refused at launch when the process runs as the superuser outside a container or sandbox (`Bypass mode cannot be used as the root user outside a sandbox.`). No setting lifts it. A container is recognised by `/.dockerenv` or `/run/.containerenv`; `IS_SANDBOX=1` or `NAMZU_SANDBOX=1` declares a sandbox the process cannot detect itself.

**Auto** is available unless `permissions.disableAutoMode: true` is set in any file, and only when a model can answer for it: the session's own model, or the one `permissions.autoMode.model` names, with a credential on this machine. Entering it by Shift+Tab adds one quiet line to the transcript, once.

## What bypass and auto still ask

In both modes these are never decided by the mode:

- a `deny` rule, and the dangerous-pattern floor: refused;
- an `ask` rule: asked;
- a catastrophic removal (the file system root, a top-level or home directory, the working directory or a parent, a cross-directory glob, a target a variable may leave empty): asked;
- a tool that always needs approval (`requiresApproval`), for instance a WebSocket `monitor`: asked;
- a sandbox escape (`dangerously_disable_sandbox`): asked every time;
- a call whose safety checks did not finish: asked.

With nobody to ask (`exec`, `exec --json`, a scheduled run), each of these is refused instead.

**Bypass** runs everything else, including a path outside the folder (`cat /tmp/x`), a program the line does not name (`$CMD build`, `$(...)`, `[[ ]]`, arithmetic), a protected-path write, and `cd sub && echo hi > f` inside your folder.

**Auto** sends what `prompt` would have asked about to the classifier, which allows or blocks it. Never sent: calls a rule allows, reads, calls `accept-edits` would allow, and the safe tools (read, grep, glob, LSP and code analysis, `search_tools`, task and plan tools), unless the call reaches outside your folders or a rule asked for it. While auto is active, allow rules for interpreters and launchers (`python*`, `node`, `bash`, `sh`, `pwsh`, `ssh`, `sudo`, `env`, `xargs`, `make`, `awk`, `npm run` and `npm test`, `pnpm build`, `bun app.ts`, `uv run`, `cargo run`, `git -c` and the like) and for delegation are not consulted, because they would approve code the classifier never read.

## The classifier

The kernel owns the mechanism ([The auto-review classifier](../sdk/auto-review.md)): two passes, fail closed, tool results never shown. This application chooses the model and pays for it.

**Which model.** `permissions.autoMode.model` names it. Left out, the session's own model and provider answer, and a model switch mid-session is followed: a check cheaper than the work it guards is easier to talk round, so quality is the default. The value is read like `smallModel`: `provider/model`, or a bare model id of the session's provider. The word `smallModel` means the side model (the cheapest priced model of the provider, or the one `smallModel` names). A name nobody can reach makes auto unavailable, with the reason, rather than quietly using another model.

**What it costs.** Each pass is charged to the turn that asked, on the same ledger as a conversation title or a `web_fetch` extraction, so `/cost` and the turn's token budget count it.

**What it is shown.** The conversation as the kernel offers it (your messages, the agent's prose and each tool call in the tool's own words), never a tool result. Each decision is logged with the tool, verdict, stage and latency, never with model text.

**When it blocks.** The model is told `Blocked by auto mode: <reason>. Do not try to work around this; if the action is needed, tell the user what you want to do and why, so they can approve it or switch modes.` After three blocks in a row, or twenty in the conversation, the terminal drops the conversation to `prompt` with one line in the transcript saying so (the footer follows), and asks you about the call that tripped it. With nobody to ask, the turn ends and says why. Over Desktop and ACP the rest of the turn is asked about, and the next message starts from the mode the person chose.

**When it cannot answer** (no credential, the provider errors, an unreadable reply, retries used up) the call is blocked, never allowed.

## Settings

All four live in the `permissions` table, beside the tool rules, in `~/.namzu/config.yaml`, `namzu.config.json`, the local file or the managed file:

```yaml
permissions:
  defaultMode: accept-edits     # prompt | accept-edits | plan | bypass | auto | strict
  disableBypassMode: false      # true: no session may enter bypass
  disableAutoMode: false        # true: no session may enter auto
  autoMode:
    model: smallModel           # default: the session's own model
    environment:
      - Our organisation is Acme and its repositories are under github.com/acme.
    allow:
      - $defaults
      - Running ./scripts/deploy-staging.sh.
    softDeny:
      - $defaults
      - Anything that touches the billing service.
    hardDeny:
      - $defaults
```

| Key | Who may set it |
| --- | --- |
| `defaultMode` | any file for the stricter modes; **only the user file and the managed file** for `bypass` and `auto` (a project value is ignored and said so at launch) |
| `disableBypassMode`, `disableAutoMode` | any file; a `true` is not undone by another file |
| `autoMode.*` | the user file and the managed file only: it chooses where the conversation goes and what the classifier lets through |

In `autoMode`, a list left out keeps the built-in rules; a list that is given replaces them; the entry `$defaults` stands for the built-ins at that position, and `[]` removes them. `allow` names ordinary work never to block, `softDeny` what is blocked unless your own messages name the action and its risky detail, `hardDeny` what is blocked whatever you said, and `environment` what is trusted here.

## Sub-agents

A sub-agent has no mode of its own. It borrows the handler of the turn that started it, so each of its calls is decided in that turn's mode as it is when the call is made: a child runs in `bypass` only while its parent does, an `accept-edits` or `auto` parent is not widened by anything the child does, and Shift+Tab back to `prompt` reaches a child that is already running. An agent file names a model and tools, never a mode.

## Headless runs

`namzu exec`, `exec --json` and the resident step take `--permission-mode` and `--yolo` the same way. With neither flag and nobody to ask, the kernel's own unattended default applies (it has no word of its own): routine calls run and anything out of bounds is refused. `--yolo` there means `bypass`, so a path outside the folder runs and the immune list above is refused. `--permission-mode auto` needs a model it can reach and exits 64 with the reason when there is none. `--allow-dangerously-skip-permissions` is for the interactive session only.

## Desktop and ACP

Desktop's permission chip offers **Ask first**, **Edit automatically**, **Auto** (Namzu's own, the classifier), **Full access** (bypass) and **Plan only**; Preapproved only appears when it is the saved mode. Full access asks once, in a dialog, before it applies, and that dialog is the person's consent. Over ACP the modes travel as the kernel's names: `bypass` and `classify`. The settings still hold there: `permissions.disableBypassMode` and the root guard refuse bypass, and auto is refused with its reason when no model can answer. A conversation that saved Full access before this change (the kernel's old `auto`) shows as Full access and means `bypass`.

The Desktop terminal tab launches the CLI with the CLI's words (`--permission-mode bypass`, `--permission-mode auto`).

For the SDK side see [The review policy](../sdk/review-policy.md) and [The auto-review classifier](../sdk/auto-review.md).
