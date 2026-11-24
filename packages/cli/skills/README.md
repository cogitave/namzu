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
- `run` — launching the project's app and using it to see a change work: the
  project's own run skill first, else a pattern for the kind of project, a
  probe beside the change, the project's check run plainly so the turn's
  record can read its status, one verdict. It replaced `verify-change`.
- `run-skill-generator` — operator only: writes the per-project `run-<unit>`
  skill after the app has been run, through `save_skill` where it exists.
- `simplify`, `commit`, `pr`, `update-config`, `fewer-permission-prompts`,
  `batch`, `debug`, `security-review` — operator only (the person types the
  command; the model never starts them on its own, and they cost no room in
  the skill list).
- `review-changes` — reviewing a change for defects, each finding with its
  failing case and checked before it is reported.
- `document` — writing a document as one well-structured Markdown file in the
  project, with a short list of assumptions and open questions in the reply.
  Word, PDF, slides and spreadsheets are not offered yet.

Each is a single `SKILL.md`. A built-in that bundles files (`scripts/`,
`references/`) must not depend on them under the sandbox: the installed
package is not mounted there, and the `skill` tool tells the model the
skill's directory is not reachable.

`src/skills/builtin-skills.test.ts` loads each one and checks the commands it
names. See `docs/cli/skills.md` in the repository.
