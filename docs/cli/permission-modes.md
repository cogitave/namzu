---
type: Reference
title: Permission modes
description: The six modes a Namzu session can run in (prompt, accept-edits, plan, bypass, auto, strict), the flags and Shift+Tab that reach them, which two need an opt-in, what each still stops for, the permissions settings that choose or shut them, how the auto classifier picks its model, how the terminal asks about one call at a time, and what Desktop and sub-agents do with them.
resource: packages/cli/src/permissions/mode.ts
tags: [cli, permissions, modes, bypass, auto, classifier]
status: stable
generated: { by: process:claude-code, at: 2026-10-22T00:00:00Z }
---

# Permission modes

A mode decides what happens to a call that no rule decided. The `[permissions]` table says what a tool may do; a mode governs the rest, for one conversation. A mode can never reopen what a rule closed: a `deny` rule and the dangerous-pattern floor (`sudo`, `curl | sh` and the like are refused, not asked about) hold in every mode. The floor checks the command a shell tool is about to run (the `bash` or `monitor` command, or the whole input of a shell tool from a plugin or server); it does not read an agent prompt, a file being written or an edit, so text that only mentions `sudo` is not refused, and a delegated agent's own shell calls are checked when they run, and an `ask` rule is asked in every mode.

| Word | Reads as | Runs without a question | Still asks (or is refused when nobody can be asked) |
| --- | --- | --- | --- |
| `prompt` | the default | reads and the read-only shell commands; with the [sandbox](tool-boundary.md#shell-commands-inside-the-sandbox-run-without-a-question) on and confining, every shell command inside it | everything else; a command that leaves the sandbox always asks |
| `accept-edits` | **Accept edits** | also `edit` and `write`, and `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` when every path they name is inside your folders | everything else; a catastrophic `rm` still asks |
| `plan` | **Plan (read-only)** | reads | any change is refused until you leave plan mode |
| `bypass` | **Bypass permissions** | everything below | the list under [What bypass and auto still ask](#what-bypass-and-auto-still-ask) |
| `auto` | **Auto** | what a second model allows | the same list, and what the classifier blocks |
| `strict` | **Preapproved tools only** | only calls a rule allows | nothing is asked: the rest is refused |

Choosing "Yes, and auto-approve edits" when a plan is approved leaves for this mode, so the writes that follow, new files and replaced ones inside your folders, run without a question. A prompt for a file write, a new file or a replaced one, offers "Yes, and switch to accept edits for this session" like an edit does, and Shift+Tab answers it. A write outside your folders, to a protected file, or whose content is too long to show in full is a one-time yes with no such row.

`strict` is for a run where nobody can be asked and every call must be pre-decided.

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

## One question per call

The terminal asks about one tool call at a time, in the order the model made them, while the batch runs. Calls that are safe to run side by side (reads, searches, fetches) start together and each opens its own question, shown first-opened-first in the order the model wrote the calls; a call that is not safe (an edit, a write, a command that changes things) waits until every call before it has finished, then asks, then runs. A call you approve starts at once. Only your own conversation asks this way: Desktop, ACP, `namzu exec` and an agent's own calls keep the whole-batch question they always had.

Each question shows its own call in full, so what you approve is exactly what runs: the input that was shown is checked again when you answer, and a call that changed after it was shown is refused alone. A call whose input is too large to show gets only a one-time **Yes**, and its siblings keep their other answers.

When two or more questions belong together, a dim `2 of 3` sits at the right of the title row, and the last of them still reads `3 of 3`; the count starts over once none is open. It counts the questions already settled, including any a rule closed for you, and it is dropped when the row has no room for it. It replaces the old "N more awaiting approval" line. A question from another agent waits behind every question of your own conversation, never takes the screen from the one you are answering, and says so in its title (`from the Reviewer agent`). Each question starts its own short settle window, so a key aimed at one cannot answer the next.

- **Yes** approves that call only.
- **No, and tell Namzu what to do differently**, or Esc, ends the turn: the calls still running are cancelled, the calls that have not started are refused without being asked, and the open questions close. Calls you approved earlier have already run. The transcript lists the calls in the order the model wrote them, the declined call with a red dot like a call that was not run (a declined write shows only that it was declined; a declined edit also shows, dimmed, what it would have changed), and ends with one dim `Interrupted · What should Namzu do instead?` row. A refused agent's call never ends your turn.
- **Tab** on the No row opens a line to say why. Enter refuses only that call and sends your words to the model (cut to 500 characters, control characters removed, and kept in the audit record as your note); the other calls carry on and are still asked. Esc puts the line away.
- **Yes, and don't ask again** and **Shift+Tab** (the answer that accepts edits, where it is offered) re-check every question still open, including those from other agents: a call the new rule or mode now covers is let through without being shown. A re-check only ever approves. A call that leaves the working directory, runs outside the sandbox, always needs a person, was asked about by a rule, or whose input was not shown in full stays open. Switching to plan or strict approves nothing.
- **Ctrl+C** at a question ends the turn exactly as a plain No does: the call on screen reads as declined, the calls not yet asked read as not run, and one `Interrupted` row closes the turn. At a narrow width the hint line keeps `tab say why` (shortened to `tab why`) on the No row ahead of the arrows and the stop key.

A call that is waiting for its yes shows in the transcript as a dim, static dot with its usual title, and a shell command adds a dim `Waiting…` where `Running…` will go. When the call starts, that row becomes its running row. A waiting row is drawn when the call's own question opens, so a call that is still queued behind earlier ones shows no row until then, and a call that was refused has its row removed. A connected server's tool is named by its server and tool in plain words (`slack · post`) in the title and the question, not by the name the model calls it. In the transcript the call reads `slack · post(hello)`, with a few words of what it was asked rather than its raw input, and its result is what the server said, without the frame that marks it for the model.

A first look at the screen is still asked as one question, before the calls that need it, and a scheduled run holds what needs a person instead of asking. A workflow's agents count as another agent's questions and queue behind your own.

### When the session ends with a question open

A question is answered by a person in the window that asked it. If Namzu is closed or killed while one is open, the calls it asked about did not run, and they are not asked about again when the conversation is resumed: nothing is replayed, and no earlier answer carries over. The transcript shows each such call as `Not run · it was waiting for approval when the session ended` (a call queued behind it reads `Not run · the session ended before it started`; a call that had started and has no result still reads `Interrupted`). `/resume` closes the left-over turn with one line (`Those calls were waiting for your approval when the session ended, so they did not run. Say what to do next.`), and sending a message does the same before it goes out. The model's next request carries an error result for each of those calls saying it did not run, nothing was changed, and to call it again if it is still needed, so it asks afresh and you answer afresh.

A killed session's turn is held for up to five minutes before another window can close it. Within that time a message or `/resume` says `This conversation is in use by another window. It is available again in about N minutes.` rather than offering to stop a reply that belongs to a process this window does not control; the same sentence is shown whenever the conversation's reply is held by a process other than this one.

## Large calls

A large write, edit or command is asked about, not refused. The prompt shows the input in a page of rows; PgUp, PgDn, Home and End move through the rest, and `d` switches between the readable view and the exact input. Approving binds exactly the input that was shown: if it changed after the prompt opened, the call is refused instead of run.

A single value over 200 thousand characters is not shown. The exact view prints a short placeholder in its place (`[about 200k characters not shown]`), and only **Yes** and **No** are offered: no "switch to accept edits" and no "don't ask again". A whole batch is capped at 1 MiB of review text; past that the remaining values are replaced the same way. A tool that has no view of its own (a connected server's tool, for example) is approved once only when its input reads as more than 2,000 units of one line, has more than 10,000 elements, or is nested deeper than 64; its input is still shown whole. A shell command or a file body is held to the 200 thousand character limit alone. A workflow's script is read whole up to 640 KiB. Input that cannot be written as plain JSON (a function, a cycle, an object with accessors) is still refused. Desktop and ACP never had a size limit and are unchanged.

When a question covers a whole batch (another agent's, a scheduled run's), the box carries one notice for the batch, however many calls are marked ("3 of 30 calls are marked below. Approving runs the batch once and is not remembered."). In a batch, each marked call says so beside its number in the list (`2. write · destructive · too large to show`, or `· long input` for a call shown whole), and a lone call is covered by the notice alone. The hint line keeps `d` (the exact input) at narrow widths and gives up `ctrl+c stop` and then the arrow-key hint first.

A call's input can be larger than one line of the session log may be. It is then written beside the log, so a batch of large writes still reaches the prompt, and a turn resumed after a restart gets the same calls back.

## Sub-agents

A sub-agent borrows the review channel of the turn that started it, so each call follows the parent's live mode. An agent file may narrow a parent in `prompt` to `plan` or `accept-edits`; it cannot grant `bypass` or `auto`, and every other parent mode remains authoritative. The same rule applies when a saved child is continued after a process restart, using the current agent definition. Shift+Tab reaches a child that is already running; see [the mode an agent file asks for](delegated-work.md#the-mode-an-agent-file-asks-for).

## Headless runs

`namzu exec`, `exec --json` and the resident step take `--permission-mode` and `--yolo` the same way. With neither flag and nobody to ask, the kernel's own unattended default applies (it has no word of its own): routine calls run and anything out of bounds is refused. `--yolo` there means `bypass`, so a path outside the folder runs and the immune list above is refused. `--permission-mode auto` needs a model it can reach and exits 64 with the reason when there is none. `--allow-dangerously-skip-permissions` is for the interactive session only.

## Desktop and ACP

Desktop's permission chip offers **Ask first**, **Edit automatically**, **Auto** (Namzu's own, the classifier), **Full access** (bypass) and **Plan only**; Preapproved only appears when it is the saved mode. Full access asks once, in a dialog, before it applies, and that dialog is the person's consent. Over ACP the modes travel as the kernel's names: `bypass` and `classify`. The settings still hold there: `permissions.disableBypassMode` and the root guard refuse bypass, and auto is refused with its reason when no model can answer. A conversation that saved Full access before this change (the kernel's old `auto`) shows as Full access and means `bypass`.

The Desktop terminal tab launches the CLI with the CLI's words (`--permission-mode bypass`, `--permission-mode auto`).

For the SDK side see [The review policy](../sdk/review-policy.md) and [The auto-review classifier](../sdk/auto-review.md).
