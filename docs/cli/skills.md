---
type: Reference
title: Skills
description: Where the CLI finds SKILL.md skills, which tier wins a name, how the model is offered them and loads one with the skill tool, which directory it is told a skill's files are in, the manifest budget, tool gating, the built-in skills, making a skill with /skills new and save_skill, the TUI's proposal to save a multi-step task with /skills save, and the skills.builtin, skills.disabled, skills.suggest and skills.suggestMinToolCalls config keys.
resource: packages/cli/src/skills/
tags: [cli, skills, config]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# Skills

A skill is a directory holding a `SKILL.md`: YAML frontmatter with a `name`
and a `description`, then a markdown body of instructions. The model sees
every usable skill's name and description in its prompt and loads a body with
the `skill` tool when a task matches the description. The operator can also
activate one for the whole conversation with `/skills <name>`, or for one
headless turn with `namzu exec --skills <a,b>`.

## Where skills come from

Six tiers are read, lowest precedence first. A skill in a later tier shadows a
skill of the same name in an earlier one; only the winner is offered.

| Tier | Directory | `source` |
| --- | --- | --- |
| Built-in | `skills/` inside the installed `@namzu/cli` package | `system` |
| Shared, user | `~/.agents/skills/<name>/SKILL.md` | `user` |
| User | `~/.namzu/skills/<name>/SKILL.md` (`$NAMZU_HOME/skills`) | `user` |
| Legacy project | `<cwd>/skills/<name>/SKILL.md` | `project` |
| Shared, project | `.agents/skills/<name>/SKILL.md` in every directory from the checkout's root down to `<cwd>`, deeper winning | `project` |
| Project | `<cwd>/.namzu/skills/<name>/SKILL.md` | `project` |

The checkout's root is the nearest directory above `<cwd>` holding a `.git`
entry; outside a checkout only `<cwd>/.agents/skills` is read. The
`.agents/skills` directories are the layout other coding agents read, so one
skill serves all of them. Directories whose name starts with `.` or `_` are
not skills. Project tiers are read only after the folder is trusted.

The built-in tier ships in the published package (`package.json` `files`
lists `skills`) and is resolved from the CLI module's own location, so it is
the same directory whether the CLI runs from source or from `dist/`.

## What the model sees

At the start of a session the CLI registers every usable winner's metadata
(`packages/cli/src/skills/catalog.ts`). Each turn then gets:

- a manifest, `<available_skills>` in the system prompt, with each skill's
  name, description and location;
- the `skill` tool, which loads a body by name, or lists every skill with its
  description (paged) when called without a name. It is never deferred behind
  tool search.

**The skill's directory.** A loaded body opens with the directory the model
can open the skill's own files in (`[Skill directory: <dir>. …]`), so a body
that says `scripts/render.sh` or `references/api.md` can be followed; the
listing gives the same `directory` for each skill
([The skill's directory](../sdk/skills.md#the-skills-directory)). The skill is
still read from where the CLI found it. Which directory is given depends on
where the tools run:

| Tools run | Skill | Directory given |
| --- | --- | --- |
| On the host (the default) | any tier | the directory it was read from |
| In the sandbox, `workspace: working-directory` | under `<cwd>` (the project tiers, a project plugin), or under an added directory | the same path, links resolved: the sandbox mounts those at their own paths |
| In the sandbox, `workspace: working-directory` | anywhere else: `~/.namzu/skills`, `~/.agents/skills`, a built-in, `.agents/skills` above `<cwd>`, a user plugin, a link out of `<cwd>` | none |
| In the sandbox, `workspace: ephemeral` | any tier | none: nothing of the host is mounted |

For a skill with none, the body opens with a line saying its directory is not
reachable from the model's tools in this session and not to search the
filesystem for its files, and `${CLAUDE_SKILL_DIR}` in its `allowed-tools`
grants nothing. The bwrap tier also mounts `/usr`, `/opt` and Node's prefix
read-only for commands, but the file tools refuse them, so a skill there is
not offered as reachable (`packages/cli/src/skills/directory.ts`). The
manifest's `<location>` is still the path the skill was read from.

Plugin skills ([Plugins](plugins.md)) join the same manifest and tool under
their `plugin__skill` names. The tiers are read again at the start of every
turn: a skill added while the session runs (by `save_skill` or by hand) is
offered from the next turn, a new file in a higher tier replaces the one it
shadows, an edited file is re-read, and a deleted one disappears.

**Budget.** The manifest is capped at the smaller of 2% of the model's context
window and 4 KB (at four characters a token). Skills are described highest
tier first, then plugins; those that do not fit are named in one line telling
the model to call `skill` without a name to read their descriptions. They stay
loadable.

**Gating.** A skill can say it needs tools:

```yaml
metadata:
  namzu-requires-tools: "browser, browser_act"
```

When any named tool is not registered in the session, the skill is left out of
the manifest and the `skill` tool answers that no such skill exists.
`/skills list` still shows it, with the tools it waits for.

**Who may invoke it.** `invocation: operator`, or `disable-model-invocation:
true`, keeps a skill away from the model: it is not in the manifest and the
`skill` tool refuses it. The operator can still activate it. The two keys
must agree; `disable-model-invocation` takes only `true` or `false`.

A skill's `allowed-tools` means what it meant before this page existed; the
catalog passes it through untouched.

## Built-in skills

The CLI ships three, in `packages/cli/skills/`:

| Skill | Offered to | Needs | What it covers |
| --- | --- | --- | --- |
| `skill-creator` | model and operator | — | Interviewing the operator (purpose, trigger phrases, steps, constraints, an example), drafting a `SKILL.md` with a description that says when to use it, and saving it only through `save_skill`. A second mode turns the work just done in the conversation into a skill: generalise the task, replace this run's specifics with placeholders, strip secrets and personal data, never copy tool or page output. Without `save_skill` (a headless run) it shows the draft and tells the operator to run `/skills new` in the TUI. |
| `browser-automation` | model only | `browser` | The procedure for the `browser` and `browser_act` tools: snapshot first, act by ref, copy `origin` from the snapshot header, verify with a snapshot, let a sign-in page or CAPTCHA pause the turn for the person and retry the step once it continues, never type credentials, never pick the profile, never route around a declined call, paginate, prefer read-only paths, report what changed. Hidden until the browser tools exist in the session. |
| `schedule-task` | model and operator | `schedule` | Proposing a scheduled job with the `schedule` tool: choosing presets or rules, `unmatched` park or deny, budgets of one run, `when` and `tz`, a browser grant (`permissions.browser`, the profile signed in with `namzu browser login`, sites at `read`/`ask`/`act`), leaving the defaults unset, and wording a prompt for a run nobody watches. Offered in the TUI, where the `schedule` tool is. |

Each is shadowed by a skill of the same name in any other tier, and none is
read when `skills.builtin` is `false`. Each is one `SKILL.md` with no files
beside it. A built-in that bundles files must not depend on them under the
sandbox: the installed package is not mounted there, and the `skill` tool
says its directory is not reachable. A test (`packages/cli/src/skills/builtin-skills.test.ts`)
loads each with the kernel's loader and checks that every `namzu …` command,
`namzu schedule add` flag and slash command it names exists, `namzu browser
login` and `--browser-site` included.

## Making a skill

`/skills new [what it should do]` in the TUI sends a prompt asking the model
to load `skill-creator` and interview you. The request, like the one `/skills save`
sends, asks for the skill in the language of your own messages rather than
in English (the request itself is written by namzu in English), and
`skill-creator` says the same. When you agree to its draft, the
model calls `save_skill`, and a screen shows:

- the whole `SKILL.md` exactly as it would be written, invisible and control
  characters shown as `<U+XXXX>`, scrollable with ↑/↓ and PgUp/PgDn;
- where each choice writes: `~/.namzu/skills/<name>/SKILL.md` (user) or
  `./.namzu/skills/<name>/SKILL.md` (project), and the one the model suggested;
- `replaces <tier> skill <path>` for every existing skill of that name it would
  overwrite or shadow, and `hidden by …` when a higher tier would keep winning;
- warnings for invisible characters, instructions to ignore instructions,
  mentions of secrets, and piping a download into a shell.

Choose **Save to user**, **Save to project** or **Cancel** (←/→ or 1–3, then
Enter; Esc cancels). Cancel is selected when the screen opens, so a stray
Enter writes nothing.

`save_skill` takes `name`, `description` and `body`, optionally `scope`
(`user` or `project`, a suggestion), `replaces` (the same name, when the model
means to update a skill) and `origin`. Before anything is shown it checks the
name (lowercase letters, digits and single hyphens, at most 64), the
description (1–1024 characters, folded onto one line), the body (not empty,
at most 64 KB, no frontmatter of its own) and that the file reads back through
the loader unchanged. It writes one file, `SKILL.md`, through a temporary file
and a rename, with provenance in its metadata:

```yaml
metadata:
  namzu-origin: created       # or learned: made from a conversation
  namzu-session: "<session id>"
  namzu-created: "2026-09-23T12:00:00.000Z"
```

**Only the TUI has it.** The App registers `save_skill` for its own session;
`namzu exec`, `drain`, a scheduled run, ACP, a resident worker and every
sub-agent build their tools without it. **Its screen is its own question, not
the permission gate's**: in `prompt`, `accept-edits` and `auto` the gate does
not ask about it, and the screen asks every time, `auto` included. `plan` and
`strict` refuse it, and a `save_skill` rule in `[permissions]` (`ask` or
`deny`) still applies (`packages/cli/src/tui/agent.ts` `reviewExemptionFor`).
A session that can save a skill also carries the `skill` tool, so the saved
skill is loadable on the next turn.

## Learning from a task

After a turn that did real work, the TUI prints one dim line under the reply:

```text
✻ That took 9 steps across 4 tools. Save it as a reusable skill? /skills save [name] · /skills save off to stop suggesting
```

It is a line in the transcript, not a question: it takes no keys, asks the
model nothing and costs nothing. Nothing is saved unless you type
`/skills save`.

**When it appears.** All of these must hold for the turn that just ended
(`packages/cli/src/tui/skills/learning.ts`):

- it ended by answering (`end_turn`), not by an error, a pause, a budget or
  a cancel;
- at least `skills.suggestMinToolCalls` (default 6) tool calls succeeded,
  across at least two different tools, and at least one of them was not
  read-only by its tool's own declaration (it wrote a file, ran a command).
  The plan bookkeeping tools (`task_create`, `task_update`, `update_goal`)
  are not counted;
- none of the last three tool results failed, and no call refused by a
  review, a rule or the mode was left without a later successful call of
  the same tool;
- the turn was your own prompt, not a goal round or a resumed turn, and it
  did not run in `plan` mode;
- no skill has been used in this conversation, by the `skill` tool or
  `/skills <name>` (an activated skill stays active after `/clear`, so it
  counts there too), and the turn was not `/skills save`, `/skills new` or a
  `save_skill` call;
- this conversation has not proposed one already (`/clear`, `/resume` and a
  fork start a new conversation);
- `skills.suggest` is not `false`.

**`/skills save [name]`** sends one turn in the same conversation asking the
model to load `skill-creator` in its "from this conversation" mode:
generalise the task, replace this run's names, paths, values and dates with
placeholders, leave out secrets and personal data, and never copy tool, file
or page output into the skill. It ends on the `save_skill` screen described
above, where you read the whole file and choose where it goes or cancel. A
name, when given, must be a valid skill name (`/skills save todo-report`);
without one the model picks one for the kind of task. Typed while a turn is
running, `/skills save` (and `/skills new`) is not steered into that turn: it
waits in the queue, says so, and runs when the turn ends.

**Saving by asking in words.** "save this as a skill", "turn it into a
skill", "bunu skill olarak kaydet", "bunu skill'e çevir" and "bundan bir skill
yap", typed into the composer, arm a [composer trigger](composer-triggers.md):
the words are highlighted and a row above the input says what will happen.
Embedded in a task ("şu TODO'ları say ve bunu skill olarak kaydet"), it runs
`/skills save` after that turn, but only when the turn completed, did tool
work and did not already save a skill, and saving is still possible (not
`plan` or `strict`); otherwise a row says why. The message on its own runs
`/skills save` at once, as if typed. The proposal line above is not printed
for a turn whose save you asked for. Alt+W drops the trigger before you send;
`composerTriggers.builtin.save-skill: off` turns the phrases off.

**Turning it off.** `/skills save off` writes `skills.suggest: false` to your
user config (`$NAMZU_HOME/config.yaml`, keeping the rest of the file as it
was) and says which file; `/skills save on` writes `true`. Either applies to
the running session at once. It then reads the whole cascade back: when a
project file, a selected profile or the managed file sets its own `skills`
block (which replaces the user file's whole block, see [Config](#config)) and
so resolves to the other value, the message names that file, says what
`skills.suggest` will be from the next start, and asks you to add `suggest`
there (`packages/cli/src/tui/skills/suggest-setting.ts`). `/skills save` and `/skills new` keep working
when proposals are off.

**It stops by itself.** A proposal counts as unused until you type
`/skills save`. After three unused in a row, across conversations, the next
one is replaced by a single line saying proposals have stopped, and none
follow until `/skills save on`. The count is kept in
`$NAMZU_HOME/skills/.suggestions.json` (`{ "v": 1, "unanswered": n, "stopped":
bool }`); a missing or unreadable file starts again from zero
(`packages/cli/src/tui/skills/suggestion-ledger.ts`).

**Only the TUI proposes.** `namzu exec`, `drain`, ACP, a scheduled run, a
resident worker and sub-agents never import the heuristic; a test checks the
import graph (`packages/cli/src/tui/__tests__/skill-suggestion-is-the-tuis-alone.test.ts`).

## Frontmatter

`name`, `description`, `license`, `compatibility`, `allowed-tools`,
`invocation`, `disable-model-invocation` and `metadata` are read. Any other
key is skipped whole, whatever YAML it uses, so a skill written for another
agent (`argument-hint: [file]`, a `hooks:` block with a list in it) loads
here with those fields ignored. The read keys are still parsed strictly: a
list or block scalar in one of them refuses the file
(`packages/sdk/src/skills/loader.ts` `SKILL_FRONTMATTER_KEYS`,
`packages/sdk/src/utils/frontmatter.ts` `readsKey`).

The model is offered a skill only when the kernel's loader accepts it: `name`
must match the directory name (lowercase letters, digits and single hyphens)
and `description` must be present. A file it refuses is left out of the
model's catalog with a warning in the log; `/skills list` shows it, and the
operator can still activate it.

## Config

```yaml
skills:
  builtin: false          # leave the built-in tier out; default true
  disabled: [noisy]       # neither the model nor /skills may use these
  suggest: false          # no "save it as a skill?" line after a task; default true
  suggestMinToolCalls: 8  # successful tool calls a turn needs first; default 6
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `skills.builtin` | boolean | `true` | Offer the built-in tier. |
| `skills.disabled` | list of names | `[]` | Skills neither the model nor `/skills` may use, in any tier. |
| `skills.suggest` | boolean | `true` | Propose saving a multi-step task as a skill ([Learning from a task](#learning-from-a-task)). `/skills save off` and `on` write it to the user config. |
| `skills.suggestMinToolCalls` | whole number ≥ 1 | `6` | Successful tool calls a turn needs before it is proposed. |

`skills.disabled` applies to a name in every tier. A disabled skill stays in
listings, marked, with the reason. Every key is read from the config files
(user, project, managed) and profiles, never from the environment
(`packages/cli/src/config/load.ts`). A later layer replaces the whole `skills`
mapping of an earlier one, so a project file that sets `skills.disabled`
also resets `suggest` to its default unless it sets it too.

## Listing

`/skills list` in the TUI and `namzu skills [--cwd <path>]` show each skill
with its source and directory tier, the `SKILL.md` files it shadows, whether
it is operator-only or gated, and why one cannot be used. `namzu --format json
skills` adds `tier`, `shadows`, `disabled`, `invocation` and
`requiresTools` to each item. `namzu skills-json` (for host UIs) prints
`{ name, description, source }` with `source` one of `system`, `user` or
`project`, and leaves disabled skills out.

## Source

- `packages/cli/src/skills/store.ts` — tiers, precedence, shadowing, listing
- `packages/cli/src/skills/catalog.ts` — the per-session registry, gating, budget
- `packages/cli/src/skills/directory.ts` — the directory the model is told for each skill
- `packages/cli/src/skills/save.ts` — `save_skill`: validation, targets, atomic write
- `packages/cli/src/tui/SaveSkillOverlay.tsx` — the confirmation screen
- `packages/cli/src/tui/skills/learning.ts` — when a turn is proposed as a skill
- `packages/cli/src/tui/skills/suggestion-ledger.ts` — the unused-proposal count
- `packages/cli/src/config/user-config.ts` — writing one key of the user config
- `packages/cli/src/tui/skills/suggest-setting.ts` — `/skills save off|on` and the override check
- `packages/cli/skills/` — the built-in skills
- `packages/cli/src/tui/agent.ts` — the catalog handed to each turn
- `packages/sdk/src/tools/builtins/skill.ts` — the `skill` tool
