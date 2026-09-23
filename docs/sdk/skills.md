---
type: Reference
title: Skills and the tool surface
description: What the skill tool loads, why a skill's allowed-tools never narrows, widens or pre-approves a tool and is never shown to the model as a limit, and where a host restricts tools instead.
resource: packages/sdk/src/tools/builtins/skill.ts
tags: [sdk, skills, tools, permissions]
status: stable
---

# Skills and the tool surface

**Loaded content cannot change the tool surface; only the host can.** Which
tools a turn may call, and how each call is authorized, come from the host's
configuration: the turn's `allowedTools` and `deniedTools`, a step's
`activeTools`, the authorization gate and the permission mode. A skill is
content, and it may arrive in a plugin nobody on the host side reviewed, so
nothing it declares reaches any of them, and the model is never told to keep
to what it declares.

The tools the model is offered and the list the executor enforces are the same
before and after a skill loads, whatever its frontmatter says.

## The `skill` tool

`SkillTool` (named `skill`) lists the model-invocable skills when it is
called without a name, and loads one skill's `SKILL.md` body by its listed
name. Long lists and bodies are paged with an opaque cursor. It is not in the
default builtin set: a host registers it next to a skills registry, passed as
`QueryParams.skillRegistry`. A skill marked `invocation: operator` is refused
even when the model names it.

## What happens to `allowed-tools`

The frontmatter value is kept as written on `SkillMetadata.allowedTools`. It
is not rendered in the skills manifest of the system prompt, and the `skill`
tool's list mode does not return it: a field named for permission reads as a
limit. When a skill that declares a non-empty value is loaded through the
`skill` tool, the result ends with one bracketed line that:

- mentions the tools the value names that this turn can call, matched to
  registered tool names exactly or ignoring case (`Read` is `read`);
- mentions the entries this turn cannot call, as written. A registered tool
  that the turn's list withholds, or that is suspended, reads the same as a
  name that is no tool at all, the rule [`search_tools`](tool-discovery.md)
  keeps, so the line does not reveal what exists outside the turn's scope;
- says it is for reference only, and that loading a skill changes neither
  which tools can be called nor how their calls are approved.

Entries that match no registered tool at all are also logged as a `warn`
through `ToolContext.log` that names the skill, so an author learns that
`shell` is not a tool. The warning is given once per tool registry, so a host
that keeps one registry for a whole session is warned once per session. A
registry that cannot list its names (`ToolRegistryRef.listNames` is optional)
gets no such check and no warning; entries are then matched against the
turn's list if it has one.

The line and the warning belong to the `skill` tool. A skill whose body a
host puts in the prompt directly, through `QueryParams.skills` or a step's
`skills`, gets neither.

`parseAllowedTools` reads both spellings in use:

| Value | Entries |
| --- | --- |
| `Read, Grep` | `Read`, `Grep` |
| `skill, read, shell, output verification` | `skill`, `read`, `shell`, `output verification` |
| `Bash(git:*) Bash(jq:*) Read` | `Bash(git:*)`, `Bash(jq:*)`, `Read` |
| `Bash(git add:*, git commit:*), Read` | `Bash(git add:*, git commit:*)`, `Read` |
| `Bash(git:*, Read, Write` | `Bash(git:*`, `Read`, `Write` |

A value with a comma outside parentheses is split on commas only, otherwise on
whitespace. Parentheses group only when they balance, so an unclosed one
cannot swallow the entries after it. An entry shaped `Name(pattern)` names
`Name`; the pattern is ignored, because the list grants nothing for a pattern
to scope. Any other entry with a parenthesis in it, such as `Bash(git:*)Read`,
names no tool and is reported as written. The skill loader drops an empty
`allowed-tools: ""`, so `[]` is reachable only through metadata a host builds
itself; neither it nor a missing value changes what a turn may call.

A `disallowed-tools` key is not read at all.

## Why it is neither a restriction nor a grant

It was a restriction, twice over. The `skill` tool handed the list to the
executor, which intersected it with the step's list from the next batch, and
it told the model to "restrict yourself to" the list. A skill that declared
`allowed-tools: skill, read, shell, output verification`, words rather than
tool names, then left the rest of the turn unable to call `bash`, `write`,
`glob` or `verify_outputs`:

```text
Tool "bash" is not available on this step. Available: skill, read, shell, output verification
```

A list that can take tools away lets whoever writes or edits a skill break a
host's defaults. Letting the same list grant or pre-approve tools would be an
escalation surface for the same reason, so it does neither.
`ToolContext.adoptSkillScope`, the hook the narrowing went through, is gone.

## Restricting tools

Restrict where the host owns the decision:

- `allowedTools` and `deniedTools` on `query()` or on the agent config, for a
  turn;
- `activeTools` returned by a `prepareStep` hook, for one step;
- `QueryParams.authorizationGate` rules such as `deny_by_name`, and the
  [review policy](review-policy.md) modes, for how a call is approved.
