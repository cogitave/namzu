---
"@namzu/sdk": major
"@namzu/cli": patch
---

A loaded skill no longer changes which tools a turn can call, and `ToolContext.adoptSkillScope` is removed.

Before, the `skill` tool handed a skill's `allowed-tools` to the executor through `ToolContext.adoptSkillScope`, and from the next batch on the turn intersected it with its own list: every tool the skill did not name was refused for the rest of the turn with `Tool "<name>" is not available on this step`. The result also told the model to "restrict yourself to" the list, and the skills manifest rendered it as `<allowed_tools>`. A skill that wrote words rather than tool names (`allowed-tools: skill, read, shell, output verification`) locked the turn out of `bash`, `write`, `glob` and `verify_outputs`.

Loaded content cannot change the tool surface now; only the host can. The tools offered to the model and the list the executor enforces are the same before and after a skill loads.

`@namzu/sdk`, what breaks:

- `ToolContext.adoptSkillScope` is gone. Nothing called it any more, and a context that still sets it no longer type-checks: delete the property. There is no replacement, because content may not narrow a turn. A test that asserted a skill was adopted should assert the skill's result instead.
- A host that relied on a skill's `allowed-tools` to withhold tools gets those tools back. Restrict where the host owns the decision: `allowedTools` or `deniedTools` on `query()` or the agent config, `activeTools` from a `prepareStep` hook, or a `deny_by_name` rule on `authorizationGate`. `allowed-tools` never pre-approves a call either; the gate and the review policy decide exactly as they do without a skill.
- The skills manifest no longer has an `<allowed_tools>` line, and the `skill` tool's list mode no longer returns `allowedTools`. A loaded skill's result ends with `[Tools this skill mentions: …]` instead of `[While following this skill, restrict yourself to: …]`: the tools the turn can call, matched to registered names exactly or ignoring case (`Read` is `read`; the pattern in `Bash(git:*)` is ignored), then the entries it cannot, without saying whether a withheld tool exists. A host that matched the old text must update.
- `parseAllowedTools` also accepts the space-separated form (`Bash(git:*) Read`), splits only on commas when the value has one outside parentheses (`output verification` stays one entry), and groups parentheses only when they balance. `read write edit` is now three entries rather than one.

Added: entries that match no registered tool are logged once per tool registry, as a `warn` through `ToolContext.log`. `ToolRegistryRef.listNames?()` is new and optional; `ToolRegistry` already has it.

`@namzu/cli`: a plugin skill's `allowed-tools` no longer takes tools away from the turn that loads it.
