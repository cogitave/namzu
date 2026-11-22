---
type: Reference
title: Permission modes
description: The six modes a Namzu session can run in (prompt, accept-edits, plan, bypass, auto, strict), auto as the interactive terminal's default and how to keep being asked, the one-time notice, the flags and Shift+Tab that reach them, what happens when auto mode cannot decide, which two need an opt-in (bypass through `permissions.allowBypassMode` or a flag), what each still stops for, the permissions settings that choose or shut them, how the auto classifier picks its model, how the terminal asks about one call at a time, and what Desktop and sub-agents do with them.
resource: packages/cli/src/permissions/mode.ts
tags: [cli, permissions, modes, bypass, auto, classifier]
status: stable
generated: { by: process:claude-code, at: 2026-11-21T00:00:00Z }
---

# Permission modes

A mode decides what happens to a call that no rule decided. The `[permissions]` table says what a tool may do; a mode governs the rest, for one conversation. A mode can never reopen what a rule closed: a `deny` rule and the part of the dangerous-command floor that guards what cannot be undone hold in every mode (see [The dangerous-command floor](#the-dangerous-command-floor)), and an `ask` rule is asked in every mode. The floor checks the command a shell tool is about to run (the `bash` or `monitor` command, or the whole input of a shell tool from a plugin or server); it does not read an agent prompt, a file being written or an edit, and a delegated agent's own shell calls are checked when they run.

| Word | Reads as | Runs without a question | Still asks (or is refused when nobody can be asked) |
| --- | --- | --- | --- |
| `prompt` | **Ask before changes**; where a terminal starts when auto cannot be used, and the default everywhere else | reads and the read-only shell commands; with the [sandbox](tool-boundary.md#shell-commands-inside-the-sandbox-run-without-a-question) on and confining, every shell command inside it | everything else; a command that leaves the sandbox always asks |
| `accept-edits` | **Accept edits** | also `edit` and `write`, and `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` when every path they name is inside your folders | everything else; a catastrophic `rm` still asks |
| `plan` | **Plan (read-only)** | reads | any change is refused until you leave plan mode |
| `bypass` | **Bypass permissions** | everything below | the list under [What bypass and auto still ask](#what-bypass-and-auto-still-ask) |
| `auto` | **Auto**, the interactive terminal's default | what a second model allows | the same list, and what the classifier blocks |
| `strict` | **Preapproved tools only** | only calls a rule allows | nothing is asked: the rest is refused |

Choosing "Yes, and auto-accept edits" when a plan is approved leaves for this mode, so the writes that follow, new files and replaced ones inside your folders, run without a question. A prompt for a file write, a new file or a replaced one, offers "Yes, and switch to accept edits for this session" like an edit does, and Shift+Tab answers it. A write outside your folders, to a protected file, or whose content is too long to show in full is a one-time yes with no such row.

`strict` is for a run where nobody can be asked and every call must be pre-decided.

## Auto is the terminal's default

An interactive terminal (`namzu`, `namzu -c`, `namzu resume`) starts in `auto` when nothing chose a mode for it: no `--permission-mode`, no bypass flag, and no `permissions.defaultMode` in any file Namzu reads (your user file, the managed file, or the project's file once the folder is trusted). A `defaultMode` in your user file or the managed file is the mode the terminal starts in. One in the project's file only keeps the terminal out of auto: the terminal then starts in `prompt`, not in the mode the project names. It does not start in auto when `permissions.disableAutoMode: true` is set in any of them, and it starts in `prompt`, without a word, when the session's classifier cannot reach a model: the same test Shift+Tab uses, so a named `permissions.autoMode.model` with no credential on this machine, or `smallModel` with no side model, starts by asking. A session with no model yet starts in `prompt` and takes `auto` once a model is chosen, as long as nothing else chose a mode in between.

The default is the terminal's only. `exec` and `exec --json`, a scheduled run, a workflow or a sub-agent (which take their parent's mode), a Pal's session, and the sessions Desktop and an ACP client own keep the modes they had: Desktop still starts every conversation in Ask first. `namzu peers send` with no `--mode` acts in the mode a new terminal here would plan to start in, auto included, so a plain send reaches a terminal in its default; a terminal that started in `prompt` because auto could not be used is reached with `--mode prompt` (see [Messages between live terminals](peer-messaging.md#from-a-command-line)).

A later session in the same terminal (another model with `/model`, another service) settles the default again, because whether auto can be used depends on the model: a terminal still in its default moves between `auto` and `prompt` with it, and the transcript says so in one line (*Auto mode cannot check actions with this model, so this terminal now asks before changes.*, or that it is in auto mode now). A mode you chose with Shift+Tab or `/permissions` is not changed.

**To keep being asked**, set it in `~/.namzu/config.yaml`:

```yaml
permissions:
  defaultMode: prompt
```

or start with `--permission-mode prompt`, or press Shift+Tab once (`auto` goes to `prompt`). `permissions.disableAutoMode: true` removes auto altogether. What auto never decides on its own is the same list as before: [What bypass and auto still ask](#what-bypass-and-auto-still-ask).

**The notice.** The first time a terminal starts in auto because of the default, the transcript shows one notice: a bold line, *Namzu now starts in auto mode.*, then a dim line saying that edits and commands that used to wait for a yes go to a separate check that reads the conversation first, that routine work goes ahead and what could do damage or what nobody in the conversation asked for is refused with the reason in the transcript, how to change the mode for the terminal or for good, and that `/permissions` explains the modes. It is shown once per person: `~/.namzu/acknowledgements.json` (the same file as the bypass answer) records it as `autoModeDefault`, and a file that cannot be written shows it again next time rather than never. A terminal started in auto by a flag or by `defaultMode: auto` shows no notice. `/permissions`, with details, says the mode is the terminal's default and how to start by asking.

## What the model is told

Under `strict`, `auto` and the unattended mode a refused call is not followed by a question. That stance arrives with the mode notice, not with the session prompt: the notice that announces the mode, sent on the first request of a session that starts in it and whenever it is switched on later, says to pick another route or report what was blocked instead of asking for approval (`strict` also says to choose a preapproved tool). The session prompt states the permission rules without a mode, so a switch never leaves a stale sentence in it and never changes the cached prefix; when the mode ends, a second notice says so and, for the default mode, that the user may be asked again. The other modes add no stance (plan mode has its own instructions).

## Reaching a mode

| How | Mode |
| --- | --- |
| `--permission-mode prompt\|accept-edits\|plan\|bypass\|auto\|strict` | that mode, for this launch only |
| `--dangerously-skip-permissions`, `--yolo` | `bypass` (a `--permission-mode` given as well wins) |
| `--allow-dangerously-skip-permissions` | keeps the launch mode, but lets Shift+Tab and `/permissions` reach `bypass` |
| `/permissions` | a menu of every mode; only `strict` and the rules are under "More options" |
| `/permissions <word>` | that mode, for this conversation |
| `permissions.defaultMode` | the mode a launch starts in when no flag names one |
| nothing of the above, in the interactive terminal | `auto` when the classifier can reach a model, `prompt` when it cannot ([Auto is the terminal's default](#auto-is-the-terminals-default)) |
| Shift+Tab | the cycle below |

`--permission-mode auto` is the classifier. It used to mean "approve everything the gates did not stop", and that is now `bypass`; to keep the old no-prompt behaviour, use `--yolo` or `--permission-mode bypass`.

### The cycle

A conversation left in `plan` comes back in `plan` when it is continued (`-c`) or resumed (`/resume`), unless the launch named a mode with `--permission-mode` or a bypass flag. The mode is saved with the conversation as a small record, written only when plan mode is entered or left; no other mode is brought back, so a continued conversation starts in your usual mode.

Shift+Tab walks `prompt`, `accept-edits`, `plan`, then `bypass` when it is available, then `auto` when it is available, then back to `prompt`. A door that is shut has no stop. A terminal that started in `auto` by default goes to `prompt` on the first press and comes back to `auto` after `plan`. `strict` is not on the cycle, and leaving it goes to `prompt`. It works mid-turn: the next decision of the running turn, and of its sub-agents, takes the new mode, and the footer is its only reply.

The footer names the mode: `⏵⏵ bypass permissions on` in red, `⏵⏵ auto mode on` in yellow, `⏵⏵ accept edits on`, `‖ plan mode on`, `‖ preapproved only on`.

The question before the screen opens when bypass starts (the one-time "Run without asking?") wraps on words at the terminal's width, and so does the red warning under the header while the mode is on. The permission box itself is described in [Terminal design](terminal-design.md): a write says whether it creates or replaces the file, and the answers keep their indent when one wraps.

## Which modes are available

**Bypass** is available only when the launch opened it: `--yolo`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypass`, or `permissions.defaultMode: bypass` or `permissions.allowBypassMode: true` in your own user file or the managed file. A project file cannot open it. `allowBypassMode` is the opt-in for choosing bypass from a menu: with it off (the default) Desktop's permission chip and an ACP client do not offer bypass, and Shift+Tab does not stop on it; a flag you type still starts the session you asked for. `permissions.disableBypassMode: true` in any file shuts it for good (it has no Settings row: it is for administrators and the managed file, and written in a file it works as before), and a flag that names it is then an error (`Bypass mode is turned off by permissions.disableBypassMode in your configuration.`). Switching to bypass from inside a session when the launch did not open it is refused with a sentence that says how to start one that can.

**The first time** a person enters bypass, one question is asked: before the screen opens when the launch is in bypass (`Start in bypass mode? [y/N]`), or in the terminal when the switch is made from inside. The answer is kept in `~/.namzu/acknowledgements.json`; answering no leaves the session in the mode it was in.

**As root.** Bypass is refused at launch when the process runs as the superuser outside a container or sandbox (`Bypass mode cannot be used as the root user outside a sandbox.`). No setting lifts it. A container is recognised by `/.dockerenv` or `/run/.containerenv`; `IS_SANDBOX=1` or `NAMZU_SANDBOX=1` declares a sandbox the process cannot detect itself.

**Auto** is available unless `permissions.disableAutoMode: true` is set in any file, and only when a model can answer for it: the session's own model, or the one `permissions.autoMode.model` names, with a credential on this machine. Entering it by Shift+Tab adds one quiet line to the transcript, once.

## The dangerous-command floor

The floor reads what a shell line runs, not its text: the commands in it after `;`, `&&`, `|`, in a subshell, in `$( )` or backticks, in a `bash -c` payload, and behind a wrapper such as `env`, `nice` or `sudo`. A word inside quotes, an `echo` argument, a heredoc body or a comment never counts, so `echo "needs sudo"` is an ordinary command. It has two tiers.

**Stopped in every mode** (the model is told what it tried and that nothing ran; you can run the line yourself):

- `rm` or `rmdir` of the file system root (`/`, `/*`), your home folder (`~`, `$HOME`, its literal path), a top-level directory (`/usr`, `/etc`, `/var`, any single name under `/`), or a variable that may be empty followed by one (`"$PREFIX/usr"` when `PREFIX` is unset or empty, `"$DIR/"`). `rm -f /usr/local/.wtest` and `rm -rf /tmp/build` are not on it; the wider removal check below still asks about the working folder and its parents;
- `mkfs` and `mkfs.*`;
- `dd` with `of=/dev/…` (not `/dev/null`, `/dev/zero` and the like);
- a fork bomb;
- `chmod 777 /` (`/*` too).

**Asked about** (in `default`, `plan` and `accept-edits` you get the normal question and can allow it once; `bypass` and `auto` lift it as they lift any other ask): `sudo`, `doas`, `pkexec`, `su -`, `ssh user@host`, `eval` of a quoted or expanded string, and a `curl` or `wget` piped straight into a shell.

With nobody to ask (`exec`, a scheduled run) an asked command is refused like any other question. A scheduled script is checked in strict mode: every one of these is refused there.

To keep the old strictness (every one of these refused in every mode, matched on the raw text), a host using the SDK sets `denyDangerousPatterns: 'strict'` on its gate. The CLI has no setting for it yet.

This is not a security boundary: a command assembled at runtime is read as far as the shell can be read before it runs, and the OS sandbox is the boundary.

## What bypass and auto still ask

In both modes these are never decided by the mode:

- a `deny` rule, and the irreversible commands of the dangerous-command floor (the file system root, the home folder or a top-level directory removed, a file system made on a device, a raw write to a device, a fork bomb, a world-writable root): refused. `sudo`, `su -`, `ssh user@host`, `eval` and a download piped into a shell are not on this list: they are asked about in the modes that ask, and bypass and auto lift them like any other ask;
- an `ask` rule: asked;
- a catastrophic removal (the file system root, a top-level or home directory, the working directory or a parent, a cross-directory glob, a target a variable may leave empty): asked;
- a call that creates or deletes a top-level entry directly in your home folder or the filesystem root (`mkdir ~/newthing`, `git clone <url> ~/repo`, `rm -rf ~/thing`, a `write` creating `~/new.txt`, `mkdir /newthing`): asked, with the path named. Anything inside an existing top-level folder (`~/projects/x/new`, `/tmp/x`) and changes to a top-level entry that is already there are not asked about. Only what can be read before the line runs counts: a path built from a variable or command substitution, or a relative path after a `cd` in the same line, is not judged. See [Where files go](where-files-go.md#the-home-folder-and-the-root-are-asked-about);
- a tool that always needs approval (`requiresApproval`), for instance a WebSocket `monitor`: asked;
- a sandbox escape (`dangerously_disable_sandbox`): asked every time;
- a call whose safety checks did not finish: asked.

The one exception runs the other way: with `permissions.outsideRoot: refuse`, a file tool's path outside the working folder is refused in both modes without asking. See [Settings](#settings).

With nobody to ask (`exec`, `exec --json`, a scheduled run), each of these is refused instead.

**Bypass** runs everything else, including a path outside the folder (`cat /tmp/x`), a program the line does not name (`$CMD build`, `$(...)`, `[[ ]]`, arithmetic), and `cd sub && echo hi > f` inside your folder.

**Auto** sends what `prompt` would have asked about to the classifier, which allows or blocks it. Never sent: calls a rule allows, reads, calls `accept-edits` would allow, and the safe tools (read, grep, glob, LSP and code analysis, `search_tools`, task and plan tools), unless the call reaches outside your folders or a rule asked for it. While auto is active, allow rules for interpreters and launchers (`python*`, `node`, `bash`, `sh`, `pwsh`, `ssh`, `sudo`, `env`, `xargs`, `make`, `awk`, `npm run` and `npm test`, `pnpm build`, `bun app.ts`, `uv run`, `cargo run`, `git -c` and the like) and for delegation are not consulted, because they would approve code the classifier never read.

## The classifier

The kernel owns the mechanism ([The auto-review classifier](../sdk/auto-review.md)): two passes, fail closed, tool results never shown. This application chooses the model and pays for it.

**Which model.** `permissions.autoMode.model` names it. Left out, the session's own model and provider answer, and a model switch mid-session is followed: a check cheaper than the work it guards is easier to talk round, so quality is the default. The value is read like `smallModel`: `provider/model`, or a bare model id of the session's provider. `provider:model` is not read: a colon is part of a model id (`gemma3:1b`). The word `smallModel` means the side model (the cheapest priced model of the provider, or the one `smallModel` names). A name nobody can reach makes auto unavailable, with the reason, rather than quietly using another model.

**What it costs.** Each pass is charged to the turn that asked, on the same ledger as a conversation title or a `web_fetch` extraction, so `/cost` and the turn's token budget count it.

**What it is shown.** The conversation as the kernel offers it (your messages, the agent's prose and each tool call in the tool's own words), never a tool result. Each earlier call carries how it ended (`ok`, `error`, `interrupted`, `rejected by the person`, `blocked by permissions`, `blocked by auto mode`, `auto mode unavailable`), from what the kernel recorded and not from what the tool printed, so a call tried again after your no or after a block is judged as a second try. Each decision is logged with the tool, verdict, stage and latency, never with model text.

**Before a git command that throws work away** (a hard reset, a forced clean, a checkout or restore over your changes, a forced push, a forced branch deletion, a dropped or cleared stash, a rebase), the classifier is also shown `git status --porcelain --branch` for the folder the command runs in, at most 40 files, read with a 2 second deadline, so it can see uncommitted work the command would destroy. Nothing is shown when the folder cannot be told from the line, git is missing or slow, the folder is not a repository, or the shell runs in a sandbox. Details in [Before a destructive git command](../sdk/auto-review.md#before-a-destructive-git-command).

**Scripts it wrote itself.** A call that launches a file the agent wrote or edited this session (`bash x.sh`, `node x.js`, `./x`, `source x`), or one that appeared during it some other way, is shown to the classifier with that file's current text: the first and last 8 KB if it is longer than 16 KB, with the cut named, and with a note when the file changed since the agent wrote it or could not be read. Without this, a script whose harmful part came after the first 300 characters of the `write` call looked like a harmless launch. Details in [The auto-review classifier](../sdk/auto-review.md#a-script-the-agent-wrote-and-then-runs). It also sees a launch it could not resolve (a path built from a variable, a program fed by a pipe it cannot follow, a file that is not there) as a note saying so, and the files a script itself runs are named as not read. A sub-agent shares the session's record of what the agent wrote, so a script the main conversation made is read when a sub-agent runs it. The re-check when the call runs is best effort. What it does not cover is listed in [the classifier's page](../sdk/auto-review.md#a-script-the-agent-wrote-and-then-runs).

**When it blocks.** The model is told `Blocked by auto mode: <reason>. Do not try to work around this; if the action is needed, tell the user what you want to do and why, so they can approve it or switch modes.` After three blocks in a row, or twenty in the conversation, the terminal drops the conversation to `prompt` with one line in the transcript saying so (the footer follows), and asks you about the call that tripped it. With nobody to ask, the turn ends and says why. Over Desktop and ACP the rest of the turn is asked about, and the next message starts from the mode the person chose.

## When auto mode cannot decide

When the classifier cannot answer (no credential, the provider errors, an unreadable reply, retries used up) the call is held back, never allowed. The model is told `Auto mode could not check this action: <reason>. Nothing was run. This is not a judgement on the action: if it is still needed, it may be tried again, and if the check keeps failing, tell the user.`

An action too long for the check to read in full (over 8000 characters) is held back the same way, without asking a model, and the model is told to split it into smaller steps, since sending it again is refused the same way; it does not count towards the stop below.

After three answers in a row with no verdict the turn stops instead of holding calls back one by one: the batch is refused, nothing runs, each refused call says the turn was stopped, and the transcript says *Auto mode could not get a safety decision, so nothing was run and Namzu stopped. Send a message to try again, or press Shift+Tab to change the mode.* The mode stays `auto` when you chose it. A terminal that was in auto only because nothing chose another mode goes back to `prompt` instead, as at the block limit, and says *This terminal now asks before changes: send a message to carry on, or use /permissions auto to go back to auto mode.* In Desktop the refused calls' cards carry the sentence. The run counts across the conversation and starts over on any real verdict; a cancelled check does not count. With nobody to ask the turn ends the same way. The three-in-a-row and twenty-in-a-conversation limits on blocks above still apply and still fall back to asking you; when one answer completes both, the turn stops.

## Settings

All six live in the `permissions` table, beside the tool rules, in `~/.namzu/config.yaml`, `namzu.config.json`, the local file or the managed file:

```yaml
permissions:
  defaultMode: accept-edits     # prompt | accept-edits | plan | bypass | auto | strict
  allowBypassMode: false        # true: bypass can be chosen from the mode menu (default: it cannot)
  disableBypassMode: false      # true: no session may enter bypass, whatever else is set
  disableAutoMode: false        # true: no session may enter auto
  outsideRoot: ask              # ask | refuse: a file outside the working folder
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
| `allowBypassMode` | **only the user file and the managed file**; a project's `true` is ignored and said so at launch. The managed file's value wins over the user file's, so an administrator can lock it off with `false` |
| `disableBypassMode`, `disableAutoMode` | any file; a `true` is not undone by another file |
| `outsideRoot` | any file; `refuse` is not undone by an `ask` in another file, so a project file can make it stricter and cannot loosen what your own or the managed file set |
| `autoMode.*` | the user file and the managed file only: it chooses where the conversation goes and what the classifier lets through |

`outsideRoot` decides what a file tool's path outside the working directory and the [added directories](add-dir.md) becomes. `ask` (the default, the same as leaving it out) is the approval request [described here](tool-boundary.md). `refuse` refuses the call without asking, before any mode is consulted, so `bypass` and `auto` do not lift it, with a message that names the setting and says `--add-dir` or `/add dir` reaches a folder. It covers `read`, `write`, `edit`, `glob`, `grep`, `ls` and every other tool that declares a path argument (`view_image`, `lsp`, `code_analysis`, `browser`); the session's scratch folder and its retained tool output stay reachable. Shell command operands and redirections are still asked about as before, and a sandboxed session does not use it (its file tools work inside the sandbox). Desktop Settings lists it as "Paths outside the working folder"; changing it asks first only when the new value is `ask`, since `refuse` narrows what can happen.

Desktop Settings, Models, edits `autoMode` as a model box and four lists and asks first when it lets more run without a person ([Desktop settings](desktop-settings.md#list-and-map-controls)). Settings, Projects, has *Allow bypass permissions mode*, which is shown turned off and cannot be changed while `disableBypassMode` is set by any layer, with one line saying who turned it off (*Turned off by your administrator.*, *Turned off by this project.* or *Turned off in your config file.*); the engine rule is unchanged, forbid beats allow. It also edits the tool rules of the same table (*Permission rules*) as a list and never touches the keys above: changing a rule leaves `defaultMode`, `allowBypassMode`, `disableBypassMode`, `disableAutoMode`, `outsideRoot` and `autoMode` as written, and *Use default* there clears only the rules.

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

`namzu exec` and `exec --json` take `--permission-mode` and `--yolo` the same way. With neither flag and nobody to ask, the kernel's own unattended default applies (it has no word of its own): routine calls run and anything out of bounds is refused. `--yolo` there means `bypass`, so a path outside the folder runs and the immune list above is refused. `--permission-mode auto` needs a model it can reach and exits 64 with the reason when there is none; when it gets no verdict three times in a row, the turn stops, nothing more runs, and `exec` says so and exits 1. Auto is not the default here: the interactive terminal's default does not reach `exec`. `--allow-dangerously-skip-permissions` is for the interactive session only.

## Desktop and ACP

Desktop's permission chip offers **Ask first**, **Edit automatically**, **Auto** (Namzu's own, the classifier), **Full access** (bypass, only after *Allow bypass permissions mode* is turned on) and **Plan only**; Preapproved only appears when it is the saved mode. Full access asks once, in a dialog, before it applies, and that dialog is the person's consent. Settings, Projects, Permissions has *Allow bypass permissions mode* (next to *Disable bypass permissions mode*, which stays the stronger one); turning it on asks first with a plain warning, and it applies the next time Namzu starts. Over ACP the modes travel as the kernel's names: `bypass` and `classify`. The settings still hold there: bypass is not advertised until `permissions.allowBypassMode` is true (or `defaultMode` is `bypass` in your own file), a prompt that asks for it anyway is refused (and so is a retry or a later pick of bypass while the opt-in is off), `permissions.disableBypassMode` and the root guard refuse it even then, and auto is refused with its reason when no model can answer. A conversation that saved Full access (or Auto) while it was open, and finds it closed since (the engine no longer advertises it), shows and sends **Ask first** instead, saves that so it is not repeated, and says once under the box: "Full access is off in Settings, so this conversation asks first again." ("Auto is off in Settings, ..." for Auto). Desktop starts every conversation in Ask first, so that is the mode it falls back to; the terminal app restores no saved mode on resume (it keeps the running one, and a configured default that is closed already falls back to prompt at launch), so it needs no such note, and a launch flag you typed still wins there.

### Changing the mode while Namzu is working

A mode chosen in Desktop's chip reaches the conversation at once, not only its next message. While a reply is running or a card is waiting, Desktop sends `namzu/session/set-permission-mode` (`{ sessionId, mode }`) to the engine, which checks the mode against the same settings as a message does, sets it on the running turn, and records the change in the log (`approval_policy_changed`, with the one-time notice to the model). The turn's next call is decided under the new mode; a call already being decided keeps the mode it was asked under, as in the terminal.

- **A card already on screen** is answered by Full access when the call is one that Full access never asks about: Desktop approves it. A call that no mode settles (a rule of yours that asks, a protected path, a removal of a home folder, a run outside the sandbox, the first look at the screen) stays open. Other modes leave an open card as it is.
- **Messages waiting in the queue** take the new mode, so a message queued under Ask first does not run as Ask first after the switch.
- **A refused mode** is not shown. When the engine refuses it (Allow bypass permissions mode is off, `permissions.disableBypassMode`, no model for Auto), the chip keeps the mode it had and Desktop says why in the engine's own words.
- With no reply running nothing is sent: the next message carries the mode, as before. An engine that does not list `namzu/session/set-permission-mode` (the `livePermissionMode` group) keeps that behaviour.

The Desktop terminal tab launches the CLI with the CLI's words (`--permission-mode bypass`, `--permission-mode auto`).

For the SDK side see [The review policy](../sdk/review-policy.md) and [The auto-review classifier](../sdk/auto-review.md).
