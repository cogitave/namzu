---
'@namzu/cli': minor
---

A session now reads more than the working folder's `AGENTS.md`. Your own `AGENTS.md` and `rules/*.md` in the Namzu home come first and apply to every project. Then each directory from the repository root down to the working folder contributes its `AGENTS.md`, every `*.md` under its `.namzu/rules/`, and its private `AGENTS.local.md` (add it to `.gitignore`; Namzu does not). A rule file whose front matter lists `paths` applies once a matching file has been read or changed.

An instruction file can include another with `@path` (relative to the file, or `~/` or `/`): up to five levels, each file once, text files only, and only from inside the repository (your own file may also include from the Namzu home and your home folder). A path outside those folders is refused and reported. HTML comments outside code are no longer sent.

This changes what existing files send: an `@docs/style.md` line in an `AGENTS.md` now includes that file, and a comment in one is dropped. To keep a mention as plain text, put it in backticks or a code block. Nothing changes for a project that has none of these.
