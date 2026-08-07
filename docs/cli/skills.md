---
title: Skills
description: Author SKILL.md capability docs, discover them, and activate one for the session with /skill.
last_updated: 2026-08-08
status: current
related_packages: ["@namzu/cli"]
---

# Skills

Skills are reusable, user-authored capability docs the agent can load on demand. A skill is a directory containing a `SKILL.md` file — YAML frontmatter plus a markdown body of guidance.

## Format

```markdown
---
name: reviewer
description: Reviews diffs for correctness and security
---

When asked to review code, focus on correctness, security, and clarity.
Call out risky patterns explicitly and suggest concrete fixes.
```

`name` and `description` are optional — if `name` is absent, the directory name is used; the frontmatter block itself is optional (a file with no frontmatter is all body).

**Frontmatter you open must parse.** Leaving it out entirely is supported, as
above. Opening a `---` fence and then writing something the reader cannot
understand is not: the skill is refused and listed with the reason, rather than
loaded as if it had no metadata. That distinction is new, and it exists because
the old behaviour put the unreadable frontmatter into the body — where it
reached the model verbatim, under a skill named after its own directory.

A refused skill does not hide the others. It appears in `/skills` marked `⚠`
with the parse error, so the file you can see on disk is accounted for.

Line endings do not matter. LF, CRLF and a lone CR all parse — a `SKILL.md`
written on Windows used to lose its frontmatter silently and show up under its
directory name with `(no description)`.

**Lists go on one line.** The reader is a flat key/value splitter, not a YAML
engine, so write `allowed-tools: Read, Bash` rather than:

```yaml
# refused
allowed-tools:
  - Read
  - Bash
```

That form used to be *dropped* — the key read as absent, so a skill that asked
for `Bash` ran without it and looked exactly like one that never asked. It is
refused now, naming the key, because a capability silently not granted is worse
than a file that will not load.

## Discovery

namzu looks in two locations:

- **User:** `~/.namzu/skills/<name>/SKILL.md` — available everywhere.
- **Project:** `<cwd>/skills/<name>/SKILL.md` — specific to the current directory.

A project skill shadows a user skill with the same name. Missing directories are fine — you just get fewer (or no) skills.

## Commands

| Command | Effect |
| --- | --- |
| `/skills` | List discovered skills, marking active ones (`●`) vs inactive (`○`). |
| `/skill <name>` | Activate a skill for this session. |

Activating a skill injects its body into the agent's system prompt for the rest of the session (alongside [memory](./memory.md)), so its guidance shapes subsequent replies. Activation is per session — restart namzu and you start fresh.

## Example

```
/skills
○ reviewer — Reviews diffs for correctness and security

/skill reviewer
Activated skill: reviewer
```

From then on, namzu applies the reviewer guidance when relevant.

`namzu skills` CLI subcommands, skill chains, and registry fetch are planned extensions.
