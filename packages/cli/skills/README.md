# Built-in skills

Each directory here holding a `SKILL.md` is a built-in skill: the
lowest-precedence tier, shipped in the published package and offered in every
session unless the config sets `skills.builtin: false`. A skill of the same
name in `~/.agents/skills`, `~/.namzu/skills` or the project shadows it.

- `skill-creator` — interview the operator and draft a skill; saves only
  through the TUI's `save_skill` confirmation (`/skills new`).
- `browser-automation` — the procedure for the `browser` and `browser_act`
  tools; offered only when they exist.
- `schedule-task` — proposing a scheduled job with the `schedule` tool.

Each is a single `SKILL.md`. A built-in that bundles files (`scripts/`,
`references/`) must not depend on them under the sandbox: the installed
package is not mounted there, and the `skill` tool tells the model the
skill's directory is not reachable.

`src/skills/builtin-skills.test.ts` loads each one and checks the commands it
names. See `docs/cli/skills.md` in the repository.
