---
"@namzu/sdk": major
"@namzu/cli": patch
---

A skill's `allowed-tools` now pre-approves its tools. It no longer restricts the tool set.

The field comes from the Agent Skills format, and that format defines it this way: the listed tools skip the approval prompt for the rest of the turn that loaded the skill, and every other tool stays callable. Namzu read it the other way. After the `skill` tool loaded a skill, the next batch was narrowed to the listed tools and the model was told to "restrict yourself to" them. A skill with `allowed-tools: Read Grep` therefore took `bash` away, and the model stopped doing the work.

**What breaks in `@namzu/sdk`**

- A loaded skill no longer narrows `ToolContext.allowedTools`. If a host relied on `allowed-tools` to confine the model, it should narrow the turn itself with `QueryParams.allowedTools`, a step's `allowedTools`, or `deny` rules.
- `ToolContext.adoptSkillScope` is deprecated. The kernel never supplies it, so a tool that calls it through `?.` now does nothing. It will be removed in the next major. Use `ToolContext.grantSkillTools`.
- `createReviewHandler` / `createReviewPolicy` in `prompt` and `accept-edits` modes now approve a batch without asking when every call it would ask about is covered by a skill loaded earlier in the turn. To keep asking about every call, pass `skillGrants: 'ignore'`. `plan` and `strict` still refuse such calls, and an operator `deny` or `ask` rule, a destructive call, or a path outside the roots or the sandbox is never covered. Each approval made this way is written to the audit trail under the skill's name.
- `parseAllowedTools` splits on whitespace as well as commas, and keeps `Tool(pattern)` entries whole. `"read write edit"` used to be one name and is now three.
- The skill manifest in the system prompt renders the field as `<pre_approved_tools>` instead of `<allowed_tools>`. The `skill` tool's notice lists what was pre-approved and what was ignored, and says every other tool remains available.

**Added:** `ToolContext.grantSkillTools`, `ToolCallSummary.skillGrant`, `approve_tools.skillGranted`, `ReviewPolicyOptions.skillGrants`, `SkillGrantSet`, `compileSkillGrant`, `SKILL_TOOL_NAME_ALIASES`, `permissionPatternToRegExpSource`, and a `FrontmatterOptions` third argument to `parseFrontmatter` (`lists`), which the skill loader uses so that `allowed-tools` can be a YAML list. Names are matched case-insensitively and through the format's aliases (`Read` → `read`, `WebFetch` → `web_fetch`). `Bash(git status *)` uses the CLI permission-table glob, applied to each command in the line. `${CLAUDE_SKILL_DIR}` and `${NAMZU_SKILL_DIR}` expand to the skill's directory. An unknown name is ignored and reported, and never widens the grant. A tool that is destructive for every input (the shipped `write` and `run_code`) is ignored and reported too, because each of its calls is reviewed anyway. `BashOutput`, `KillShell`, `TaskOutput` and `TaskStop` map to `job`, and `TaskCreate`, `TaskUpdate` and `TaskList` to `task_*`. `ToolContext.grantSkillTools` returns a `commit()`, and the `skill` tool records the grant only once it has delivered the skill's instructions.

**`@namzu/cli`:** a plugin skill's `allowed-tools` pre-approves for the turn and no longer takes tools away. `SKILL.md` files whose `allowed-tools` is a YAML list are now listed instead of refused. The `[permissions]` glob now comes from the SDK, and it matches the same commands as before.
