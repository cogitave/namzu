---
"@namzu/desktop": patch
---

The "Trust this folder?" dialog names the hooks a folder's config declares even when they are written in the common hook contract's shape (a group with a `hooks` list): Details shows the command, the `POST` address or the question inside each group, where it used to show "(more settings, not shown)". An `http` or `prompt` hook in either shape is named too. Nothing to do.
