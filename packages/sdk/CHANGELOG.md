# Changelog

All notable changes to Namzu are documented here.

## [0.1.7] — 2026-04-15

### Documentation

- **changelog**: add 0.1.6 (sdk) and 0.1.0 (computer-use) entries; fix cliff tag prefix + workflow race
- **changelog**: update for sdk-v0.1.6-rc.1
### Features

- **bedrock**: extract BedrockProvider to @namzu/bedrock package (Phase I.3 pilot)
- **openrouter**: extract OpenRouterProvider to @namzu/openrouter package (Phase I.4)
### Refactor

- **sdk**: address Codex review — scope providers/ subfolder, hide registry reset
- **sdk**: replace ProviderFactory with ProviderRegistry for per-vendor extraction [**BREAKING**]
## [0.1.6-rc.1] — 2026-04-15

### Documentation

- **changelog**: update for v0.1.5
### Features

- **sdk**: add ComputerUseHost interface and computer_use tool
### Miscellaneous

- initialize namzu monorepo from sdk; add @namzu/computer-use capability package
## [0.1.5] — 2026-04-15

### Bug Fixes

- **emergency**: uuid tmp suffix, outer try/catch, and explicit exit
- **store**: resolve withLock race, delete deadlock, and atomic edge updates
### Documentation

- **changelog**: update for v0.1.5-rc.2
### Refactor

- **barrels**: route root barrel through sub-barrels (Path B)
- **connector**: brand ConnectorId/TenantId on public interfaces [**BREAKING**]
### Testing

- **store**: add concurrency regression tests for DiskTaskStore
## [0.1.5-rc.2] — 2026-04-14

### Bug Fixes

- **plugin**: wire MCP servers and fail fast on unsupported contributions
- **plugin**: consume hook results and wire tool hooks in runtime
- **release**: normalize pre-release counter to strip non-digit suffix
### Documentation

- **changelog**: update for v0.1.5-rc.1-fix
- **contracts**: formalize wire/domain duality + refresh README
- **readme**: rewrite code examples to match current SDK API
### Refactor

- **plugin**: remove duplicate PluginConfigSchema in types/
- **registry**: migrate Agent/Connector/Tool registries to ManagedRegistry
- **run**: remove legacy Session* aliases for run-centric classes
## [0.1.5-rc.1] — 2026-04-12

### Documentation

- **changelog**: update for v0.1.4
### Refactor

- architectural cleanup and infrastructure improvements
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

