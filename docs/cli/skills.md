---
type: Reference
title: Skills
description: Where the CLI finds SKILL.md skills, which tier wins a name, how the model is offered them and loads one with the skill tool, the manifest budget, tool gating, the built-in skills, making a skill with /skills new and save_skill, and the skills.builtin and skills.disabled config keys.
resource: packages/cli/src/skills/
tags: [cli, skills, config]
status: stable
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
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
| `browser-automation` | model only | `browser` | The procedure for the `browser` and `browser_act` tools: snapshot first, act by ref, copy `origin` from the snapshot header, verify with a snapshot, stop on a sign-in page or CAPTCHA, never type credentials, paginate, prefer read-only paths, report what changed. Hidden until the browser tools exist in the session. |
| `schedule-task` | model and operator | `schedule` | Proposing a scheduled job with the `schedule` tool: choosing presets or rules, `unmatched` park or deny, budgets, `when` and `tz`, and wording a prompt for a run nobody watches. Offered in the TUI, where the `schedule` tool is. |

Each is shadowed by a skill of the same name in any other tier, and none is
read when `skills.builtin` is `false`. A test (`packages/cli/src/skills/builtin-skills.test.ts`)
loads each with the kernel's loader and checks that every `namzu …` command,
`namzu schedule add` flag and slash command it names exists; the
`namzu browser` commands `browser-automation` and `schedule-task` mention
arrive with the browser feature and are listed there as pending.

## Making a skill

`/skills new [what it should do]` in the TUI sends a prompt asking the model
to load `skill-creator` and interview you. When you agree to its draft, the
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
  builtin: false        # leave the built-in tier out; default true
  disabled: [noisy]     # neither the model nor /skills may use these
```

`skills.disabled` applies to a name in every tier. A disabled skill stays in
listings, marked, with the reason. Both keys are read from the config files
(user, project, managed) and profiles, never from the environment
(`packages/cli/src/config/load.ts`).

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
- `packages/cli/src/skills/save.ts` — `save_skill`: validation, targets, atomic write
- `packages/cli/src/tui/SaveSkillOverlay.tsx` — the confirmation screen
- `packages/cli/skills/` — the built-in skills
- `packages/cli/src/tui/agent.ts` — the catalog handed to each turn
- `packages/sdk/src/tools/builtins/skill.ts` — the `skill` tool
