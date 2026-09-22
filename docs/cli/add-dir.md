---
type: Reference
title: Adding a directory
description: How a session lets the file tools reach a directory besides the working directory — /add-dir, --add-dir, the additionalDirectories config key — what changes for the tools, the sandbox and the model, and what stays contained.
resource: packages/cli/src/context/directories.ts
tags: [cli, files, sandbox]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Adding a directory

The file tools reach the working directory without asking. A path elsewhere is asked about call by call on the host (refused when nobody can be asked) and refused inside the sandbox (see [Where tools run](tool-boundary.md)). A monorepo sibling, a shared library checkout, a notes folder: when a task needs one repeatedly, add it.

- **`/add-dir <path>`** adds it for the rest of the session; relative to the working directory or absolute. A directory outside the working directory is added only after you answer yes to the question it asks, since adding it lets every file tool reach it without asking again. Inside or outside is decided after links are followed, as the file tools decide it: a link in the working directory that points elsewhere is asked about, the question names where it leads, and that canonical path is what is stored, so a link retargeted afterwards does not carry the approval with it. A directory inside the working directory is not added, since the tools already reach it and a root inside the tree the agent writes to could later be swapped for a link. `/add-dir` alone lists what is added.
- **`--add-dir <path>`**, repeatable, adds it for one launch.
- **`additionalDirectories`** in `namzu.config.json` or `~/.namzu/config.yaml`, a list of paths, adds it for every session in the project.

## What changes

- **The tools.** `read`, `edit`, `write`, `glob`, `grep`, `ls` and the language-server tool accept an absolute path inside an added directory. Relative paths still resolve against the working directory. A path outside every root is an approval request on the host and a refusal inside the sandbox.
- **The sandbox.** A sandboxed run binds each added directory read-write at its own path, so a path the model was given on the host means the same thing inside. Under bwrap that is a bind mount; under seatbelt a pair of read and write rules. The sandbox's own file API is contained to the same set.
- **The model.** The environment prompt names the added directories, so the model uses them by absolute path instead of guessing at `..`, and it suggests `/add-dir` when it needs a directory repeatedly.
- **`/status`** lists them under where the session may write.

## What does not change

A directory added mid-session reaches the tools from the next turn, not the running one. The kernel's `additionalDirectories` is the same list; see the SDK's `ToolContext.additionalDirectories`. Checkpoints (`/restore`) cover the working directory only.
