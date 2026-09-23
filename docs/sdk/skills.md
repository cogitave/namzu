---
type: Reference
title: Skills and allowed-tools
description: How the skill tool loads a SKILL.md, and what its allowed-tools grants for the rest of the turn.
resource: packages/sdk/src/authorization/skill-grant.ts
tags: [sdk, skills, permissions, hitl]
status: stable
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
---

# Skills and allowed-tools

A skill is a directory with a `SKILL.md`: YAML frontmatter (`name`, `description`, optional `allowed-tools`, `invocation`, `license`, `compatibility`, `metadata`) and a markdown body. The system prompt lists the skills the model may use. The body reaches the model when it calls the `skill` tool (`SkillTool`, `packages/sdk/src/tools/builtins/skill.ts`) with the skill's listed name. A host registers that tool next to a `SkillRegistry` and passes the registry to `query()` as `skillRegistry`.

# What allowed-tools means

`allowed-tools` **pre-approves**. It never restricts. This is how the Agent Skills format defines it:

- Once the `skill` tool loads a skill, a call its `allowed-tools` covers skips the approval prompt **for the rest of that turn**. It does not apply to the batch that loaded the skill, because that batch was reviewed before the skill was read. Loading the skill again in a later turn grants again.
- **Every other tool stays callable.** A call the grant does not cover is reviewed as it would be with no skill loaded. The turn's tool list (`allowedTools`) is never narrowed.
- The grant ends with the turn. `query()` creates one `SkillGrantSet` per turn, fills it from the `skill` tool and reads it in review. The next user message starts an empty set.
- A delegated child runs its own turn with its own empty set, so it does not inherit its parent's grant. That holds even when it borrows the parent's review handler: the handler honours only calls that the child's own review marked.

Before this release the field was read the other way round. The tool told the model to "restrict yourself to" the listed tools, and the executor narrowed the next batch to them. A skill with `allowed-tools: Read Grep` therefore left the model without `bash`. `ToolContext.adoptSkillScope` belonged to that behaviour. The kernel no longer supplies it, it is deprecated, and it will be removed in the next major.

## What a grant can never override

A skill is repository content, so it ranks below the operator and below the tool itself. The kernel marks a call as covered (`ToolCallSummary.skillGrant = { skill }`) only when the operator's policy leaves the call to review and none of these applies:

- an operator `deny` rule refuses it (the gate refuses it before review);
- an operator `ask` rule (`authorization.explicitReview`) names it;
- the tool declares the call destructive;
- the call carries an escalation, meaning a path outside the working directory or a sandbox escape.

The shipped review policy (`createReviewHandler`) approves a batch without asking only if every call it would have asked about carries that mark. Under `plan` and `strict` it refuses first, so a skill grant never gets past plan mode or an allowlist-only turn. Under `auto` everything was approved already. If one call in the batch is unmarked, the whole batch is asked about. A host that writes its own handler sees the mark and decides for itself. A host that does not want skills to reduce its prompts passes `skillGrants: 'ignore'` to `createReviewHandler` / `createReviewPolicy`, and every call is then asked about as if no skill had been loaded.

Each call approved on a skill's word is written to the session's audit trail as `{ what: { action: 'tool_call', tool }, outcome: 'approved', reason: 'pre-approved by the allowed-tools of skill "<name>" for this turn; nobody was asked' }`. The handler reports those calls in `approve_tools.skillGranted`, and the kernel records only ids that actually carried the mark.

## Trust

A grant is equivalent to the operator trusting that skill's commands. Only a skill the host chose to register can grant anything: a name the registry does not have fails to load and grants nothing. The CLI loads model-invocable skills only through plugins, and those are off by default and loaded only after the folder-trust gate admits the working directory. In a folder nobody has trusted, no session starts until the operator trusts it, so that folder's `.namzu/plugins` cannot grant. A skill the operator activates with `/skill <name>` is placed in the system prompt and never goes through the `skill` tool, so it grants nothing either. A trusted folder that later pulls in a hostile skill is outside what trust protects, as [Plugins in the CLI](../cli/plugins.md) says of plugin code. Review a skill's `allowed-tools` the way you would review a permission rule.

# Syntax

`parseAllowedTools` accepts every spelling the format uses:

```yaml
allowed-tools: Read Grep Bash(git status *)
allowed-tools: Read, Grep
allowed-tools: [Read, Grep]
allowed-tools:
  - Read
  - Bash(git add *)
```

The frontmatter reader accepts a YAML list for `allowed-tools` only (`parseFrontmatter(raw, source, { lists: ['allowed-tools'] })`) and joins it into one comma-separated scalar. Every other key still refuses a list. A comma or space inside parentheses belongs to its entry.

**Names** are matched case-insensitively against the turn's registry, through the aliases the format uses (`SKILL_TOOL_NAME_ALIASES`):

| Written | Tool here |
| --- | --- |
| `Read`, `Write`, `Edit`, `MultiEdit` | `read`, `write`, `edit`, `edit` |
| `Bash`, `Grep`, `Glob`, `LS` | `bash`, `grep`, `glob`, `ls` |
| `WebFetch`, `WebSearch` | `web_fetch`, `web_search` |
| `Skill`, `AskUserQuestion`, `LSP` | `skill`, `ask_user_question`, `lsp` |
| `Task`, `Agent` | `create_task` |

Any other name is looked up as written, without regard to case, so `mcp` tool names and host tools work. The `skill` tool reports a name the turn has no tool for as ignored, and that entry grants nothing. It never widens to everything.

**Patterns.** `Bash(<pattern>)` grants only command lines that match. The glob is the one the CLI's `[permissions]` table uses (`permissionPatternToRegExpSource`): `*` is any run of characters and `?` is one character, and a trailing ` *` also matches the bare command. `Bash(git status *)` therefore covers `git status` and `git status -s` but not `git statusx` or `git push`. A line is read as the commands it runs, and every one of them must match, so `git status && git push` is not covered. A line the reader cannot see through, such as a substitution or a heredoc, is not covered either. The legacy form `Bash(npm run test:*)` means `npm run test *`. `Bash(*)` and `Bash` both grant the whole tool.

`${CLAUDE_SKILL_DIR}` and `${NAMZU_SKILL_DIR}` in a pattern expand to the skill's directory, for example `Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)`. If the registry does not say where the skill lives, the entry is ignored.

A pattern is honoured only for a tool that declares a command argument (`commandArgument`, which `bash` does). `Read(./src/**)`, `WebFetch(domain:…)` and similar entries are ignored with a reason rather than approximated, because the only safe approximation of a permission is a narrower one.

# What the model is told

The `skill` tool appends one notice to the body. It lists what is pre-approved, any ignored entries with their reasons, and always: "Every other tool remains available and is reviewed as usual; this skill does not limit which tools you may use." Outside a turn (no `ToolContext.grantSkillTools`) it says that the host applies no pre-approval. The manifest shows the field as `<pre_approved_tools>`, not `<allowed_tools>`, because the old tag read as a whitelist.

# API

| Symbol | Role |
| --- | --- |
| `parseAllowedTools(value)` | Split the frontmatter value into entries. |
| `compileSkillGrant(entries, { resolveTool, skillDirectory })` | Resolve names and compile patterns against a registry. Returns `{ entries, ignored }`. |
| `SkillGrantSet` | The per-turn set: `grant(skill, compiled)`, `coveringSkill(call, toolDef)`, `list()`, `size`. |
| `ToolContext.grantSkillTools` | Supplied by the executor inside a turn. The `skill` tool calls it. |
| `ToolCallSummary.skillGrant` | The review phase's mark on a covered call. |
| `HITLResumeDecision` `approve_tools.skillGranted` | The ids a policy approved on a skill's word, for the audit trail. |
