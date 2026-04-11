# Changelog

All notable changes to Namzu are documented here.

## [0.1.4] — 2026-04-11

### Documentation

- **changelog**: update for v0.1.4-rc.3
### Features

- sandbox isolation, new tools (edit/grep/ls), session-to-run migration
## [0.1.4-rc.3] — 2026-04-10

### Miscellaneous

- **release**: derive version from git tag, no manual bump needed
## [0.1.4-rc.2] — 2026-04-10

### Bug Fixes

- **ci**: remove duplicate --strip flag in git-cliff command
- **plugin**: rename session hooks to run_start/run_end
- **release**: use tag name as release title instead of prefixed name
### Features

- P3 + plugin architecture — emergency save, memory index, plugin system
- P2 — AgentBus, prompt cache split, verification gate
- integrate compaction loop and advisory phase into iteration pipeline
### Miscellaneous

- **changelog**: automate CHANGELOG.md via git-cliff in release workflow
## [0.1.4-rc.1] — 2026-04-10

### Bug Fixes

- add description field to package.json, reorder README badges
### Features

- **advisory**: provider-agnostic advisory system with three-layer architecture
- structured compaction, tool tiering, task router
- output discipline, shell compression, pre-release workflow
### Miscellaneous

- remove BEFORE-RELEASE.md from repo
## [0.1.3] — 2026-04-10

### Bug Fixes

- point entry fields to dist/ for bundler compatibility
### Documentation

- add npm, ci, license, typescript, node badges to README
## [0.1.2] — 2026-04-10

### Other

- Namzu v0.1.1 — Wisdom, shared

Open-source AI agent framework by cogitave.

Let's build the agent layer together.
### Refactor

- constants centralization, strict lint, release automation

