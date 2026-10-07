---
'@namzu/cli': minor
---

The Desktop host (`namzu acp --desktop`) gains two read-only ACP methods, `namzu/project/changes` and `namzu/project/diff`, so the Desktop Changes view can review uncommitted work. `changes` lists the working tree against HEAD (status, added and removed lines, renames, binary and untracked files, at most 2,000 files) and answers `null` for an untrusted folder or a folder that is not a repository; `diff` returns both sides of one changed file, confined to the project folder and capped at 2 MiB. Nothing to change on upgrade: an older Desktop never calls them, and a newer Desktop talking to an older CLI simply hides the view.
