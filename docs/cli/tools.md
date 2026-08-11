---
title: Tools & permission
description: Builtin tools, agent memory + task tools, deferred tools and search_tools, how a tool call is decided, the permissions file, the safety gate, and bypass mode.
last_updated: 2026-08-09
status: current
related_packages: ["@namzu/cli", "@namzu/sdk"]
---

# Tools & permission

namzu drives the full `@namzu/sdk` agent loop, so the model can call tools: read files, run shell commands, edit code, search, track a plan, and remember things. Tool results feed back into the loop until the turn settles.

## Builtin tools

Every session registers a lean, native tool set:

| Tool | Purpose |
| --- | --- |
| `bash` | Run a shell command. |
| `read` | Read a file (line-range aware). |
| `write` | Write a file. |
| `edit` | Replace text in a file. |
| `glob` | Match files by pattern. |
| `grep` | Search file contents. |
| `search_memory` / `read_memory` / `save_memory` | The agent's structured memory ([Memory](./memory.md)). |
| `task_create` / `task_update` / `task_list` | Track a plan for the current request (see below). |
| `search_tools` | Load a deferred tool on demand (see below). |

## Plan / task tracking

The agent can lay out a multi-step plan with the task tools. New tasks appear in the transcript as `☐ <subject>` and completed ones as `☑ <subject>`, so you can watch it work through a todo list for the current request.

## Deferred tools and `search_tools`

A **deferred** tool is registered but not offered to the model directly: it costs a name in the prompt rather than a full JSON schema, and the model loads it when it needs it by calling `search_tools`. That keeps per-turn token cost flat as the tool count grows.

In a namzu session the task tools above are the deferred set — they are registered when the session opens a task store, and `search_tools` is mounted alongside them so the model can reach them.

They register during the **first turn**, not at connect. So `Connected to … · N tools` does not count them — it reports what was callable at the moment it connected — while `/tools` and `/permissions` are asked later and answer for the moment you ask. Running one turn and then `/tools` is the reliable way to see the full roster.

A sub-agent runs without a task store, so it has nothing deferred, and `search_tools` is not mounted there at all: a tool whose only possible answer is "nothing matched" costs a turn to discover that.

> Earlier versions bridged an external daemon's ~70-tool catalog in as deferred tools, and the connect line reported them as `(+N on demand)`. That integration was removed in `@namzu/cli` 0.7.0 — see the changelog.

## How a tool call is decided

Every call goes through the same two stages, in this order.

**1. The verification gate** answers `allow`, `deny`, or `review`, consulting three things in this order:

1. **The safety floor** — a narrow set of catastrophic shell patterns is denied outright and outranks everything below (see [The safety gate](#the-safety-gate)).
2. **Your rules** — the [`permissions` table](#the-permissions-file), if you wrote one. An `allow` or `deny` here settles the call.
3. **The read-only allowance** — a tool that only observes is allowed.

Anything still undecided comes back `review` — the gate has no opinion, and the decision moves on.

Your rules are consulted *before* the read-only allowance, which is what makes `read: ask` reachable: were the order reversed, a rule asking to be prompted about a read would be silently unreachable.

**2. The mode** decides what happens to a `review`. Which mode is in force depends on where you are:

| Mode | A reviewed call is | In force when |
| --- | --- | --- |
| `prompt` | put to you (see below) | the TUI, normally |
| `auto` | approved | any headless run with no flag; the TUI under bypass |
| `strict` | refused | `namzu run --permission-mode strict` |

`--permission-mode` is a headless flag — see [Headless runs](./headless.md#permission-modes). The TUI is `prompt` unless you launched it with bypass.

**A mode never reopens what the gate closed.** A denied call was already stopped and an allowed one never asked, so neither reaches the mode. That is why `--yolo` cannot run a catastrophic command: the denial happens a stage earlier — and equally why a `deny` you wrote is not something bypass can undo.

## The permissions file

A `permissions` table says what a tool may do without asking. namzu reads two
config files, and the later one wins:

| File | Scope |
| --- | --- |
| `~/.namzu/config.yaml` | you, everywhere |
| `./namzu.config.json` | this project |

```yaml
# ~/.namzu/config.yaml
permissions:
  read: allow
  bash:
    "git status": allow
    "git push*": deny
  write: deny
```

```json
// ./namzu.config.json
{
  "permissions": {
    "read": "allow",
    "bash": { "git status": "allow", "git push*": "deny" }
  }
}
```

An effect is `allow`, `ask` or `deny`, either for a whole tool or per argument
pattern. More specific patterns are matched first.

**An `allow` pattern has to match from the start of an argument's value.** So
`"git status*"` allows `git status` and `git status --porcelain`, and does not
allow `rm -rf ~/.ssh; git status` — which it used to, because the pattern was
matched anywhere in the call's arguments and the text an operator named could be
preceded by anything. If you want the loose form, write it: a pattern starting
with `*`, such as `"*git status*"`, still matches anywhere.

**A `deny` pattern is still matched anywhere, deliberately.** A deny that
stopped matching would fail open — `"rm -rf*"` is meant to catch
`sudo rm -rf /var` too — while a deny that matches too much only costs you a
prompt.

Two limits are worth knowing, because both follow from a pattern being matched
against the call's arguments as a whole rather than against one named argument:
a pattern can match the start of **any** argument's value, not only the one you
had in mind, and the match is open-ended on the right, so `"git status *"` also
covers `git statusx`. Write a `deny` for anything you need refused rather than
relying on an `allow` being narrow.

**`ask` is the default, so writing it changes nothing** — an unmatched call is
already asked about. It is spelled out so a table can say what it means rather
than leaving a reader to infer it from an absence, and it is why there is no way
to widen by omission: the only way to allow something is to say so.

**The table is replaced, not merged.** A project file's `permissions` overrides
a user file's entirely rather than combining key by key, so a project config that
sets one rule does not inherit the rest.

**It applies to the interactive TUI as well as `run` and `run-stream`** (since
0.7.0 — before that the table was dropped before it reached any of them). A
`deny` in an interactive session means the call is refused outright rather than
prompted, which is the point of writing one: it protects you from approving by
reflex.

For what happens to calls no rule covered, see
[permission modes](./headless.md#permission-modes).

## The permission prompt

Under `prompt`, mutating actions ask before they run:

- **Tools that declare themselves read-only** (`read`, `glob`, `grep`, `ls`, `search_memory`, `read_memory`, `task_list`) run silently. That is taken from each tool's own declaration, not from a list namzu keeps.
- **`task_create` and `task_update`** also run silently, and they are writes. They are the model's own plan for the request, written several times per planning turn, so prompting would put a dialog between the agent and its todo list; a bad write costs a polluted task list, which is visible in the transcript and grants nothing.
- **`save_memory` prompts.** It used to be silent. What it writes outlives the run — content saved now is retrievable by `search_memory` in a later session, from `<cwd>/.namzu/memory` inside your own project — so a tool result or fetched page that talks the model into saving something reaches a future run's reasoning.
- **Anything else** — `write`, `edit`, `bash`, and any tool not on the safe allowlist — shows a prompt with each proposed call, plus a preview for the riskiest: the content for `write`, a `- old` / `+ new` diff for `edit`.

An unrecognized tool is treated as needing consent. That direction is deliberate: a tool added tomorrow prompts, rather than inheriting a permission nobody granted it.

| Key | Decision |
| --- | --- |
| `y` | Approve this batch. |
| `a` | Approve this and everything else for the rest of the session. |
| `n` (or `Esc`) | Decline — the model is told, and **the turn continues**; it can adapt and try something else. |
| `Ctrl+C` | Decline **and stop the turn**. |

The last two are not the same decision, and the prompt says so on screen rather
than only here. Declining with `n` leaves the agent working: it will pick another
approach, which is usually what you want when one particular call was wrong. If
you want namzu to stop, `Ctrl+C` is the key — pressing `n` and waiting is how
that goes wrong.

**`Enter` does not approve.** It used to, and it no longer does. The prompt
arrives on the agent's schedule rather than yours: the composer stays editable
while a turn runs, so the overlay can replace a composer you are part-way
through typing into, and `Enter` is the key most likely to be already on its way
when that happens. Approving is the one decision here that cannot be taken back,
so it is not reachable by the key people press to dismiss things.

For the same reason an approving key (`y`, `a`) is ignored for a beat after the
prompt opens, so a keystroke aimed at the composer behind it cannot land on it.
Rejecting is never deferred — `n`, `Esc` and `Ctrl+C` answer on the first press,
because a refusal you did not mean costs a retry while an approval you did not
mean costs whatever the tool did.

### Checking what is in force

`/permissions` prints the posture actually in force, not the one your flags
imply. That distinction matters after you press `a`: approve-all is a session
setting, so the page reports it as automatic approval and tells you how to get
back to being asked (restart, or re-pick a provider with `/model`).

It also names the tools that never reach a prompt, because that set is otherwise
undiscoverable — those calls simply never appear, so their absence looks like
the agent not having used any.

## The safety gate

Independent of the prompt, a verification gate hard-denies a narrow set of catastrophic shell patterns **before they ever run** — `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `sudo` / `su -`, `chmod 777 /`, `curl|sh` / `wget|sh`, `ssh user@host`, and dynamic `eval`. This applies in every mode including bypass, so namzu can't be made to brick the machine. The list is deliberately narrow — everyday commands like `rm -rf node_modules` are unaffected.

## Bypass mode

Launch with `namzu --dangerously-skip-permissions` (alias `--yolo`) to run tools without the approval prompt — useful in a sandbox or a folder you fully trust. A red banner warns while it's active, and the safety gate above still applies.

On the headless commands the same two flags mean `--permission-mode auto`, which is what a headless run already defaults to. They were previously accepted there and did nothing.

The name overstates what the flag can do, and that is on purpose: it should read as more dangerous than it is rather than less.

> The permission prompt is interactive only in the TUI. Programmatic/embedded use of the session auto-approves unless a permission handler is supplied.

## Unattended runs

`--permission-mode strict` is the one to reach for in CI. Read-only tools still run; everything else is refused, and the refusal tells the model that asking again will not help, so it stops rather than rewording the same call.

Before it existed an unattended run could only be `auto`, so a scheduled job either trusted the agent with every tool it might reach for or could not use it at all.

If you need an unattended run that may also write or execute, the rule surface for that lives one layer down, in the SDK's verification gate — see [Tool Safety](../sdk/tools/safety.md) for the rule vocabulary and how a host supplies it.
