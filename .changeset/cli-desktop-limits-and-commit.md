---
'@namzu/cli': minor
---

The Desktop host sends a new `namzu/limits` notification and answers `namzu/limits/refresh` with what each provider in use says about its account (windows from response headers, key credit, balance, or a local spend estimate), and answers `namzu/project/commit-preview` and `namzu/project/commit` so Desktop can commit the files one conversation changed (trusted folders only; never `add -A`, never a skipped hook, never a push). Additions only: a Desktop that does not know them ignores them, and the terminal is unchanged.
