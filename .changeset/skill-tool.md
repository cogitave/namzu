---
'@namzu/sdk': minor
---

A `skill` tool, and `allowed-tools` that actually narrows.

The manifest told the model a SKILL.md exists and to "read the SKILL.md at its `<location>` before writing code" — a filesystem instruction. A run without filesystem tools could see every skill it had and open none of them. The protocol text even hedged: *"when the runtime exposes filesystem or skill-loading tools"*. There was no skill-loading tool.

`allowed-tools` failed from the other side: parsed, stored on `SkillMetadata`, rendered into the prompt as `<allowed_tools>…</allowed_tools>`, and read by nothing. It was advice the model could ignore, phrased as a declaration.

New: `SkillTool`, `SkillRegistryRef` on `ToolContext`, and `skillRegistry` on `query`. The tool is **not** in the default builtin set — a run with no skills has nothing for it to do, and offering a tool that can only refuse is worse than not offering it.

A loaded skill's `allowed-tools` is **adopted**, on the same line that already enforces the step's list. Two properties make it safe:

- It **intersects** what the turn already allows and can never widen it. A skill file is content, and content that can grant tools is a privilege-escalation surface wearing the word "scope" — the same rule `CreateTaskOptions.toolScope` states for delegation.
- It lands on the **next** batch. A skill loaded alongside other calls must not retroactively refuse them: the model chose that batch under the old scope, and refusing half of it teaches nothing except that tools fail at random.

The `skill` tool itself always survives a narrowing, or a skill could narrow the model out of reaching for another skill — a one-way door.

`allowed-tools: ""` means no tools, and stays distinguishable from declaring nothing at all: collapsing the first into the second would silently widen it to everything. An operator-only skill is refused at the tool even though the manifest omits it — a check that only filtered the listing would be a menu restriction rather than a kitchen one, which is the defect `allowedTools` had.
