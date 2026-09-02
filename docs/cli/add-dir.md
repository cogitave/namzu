---
type: Reference
title: Adding a directory
description: How a session lets the file tools reach a directory besides the working directory — /add-dir, --add-dir, the additionalDirectories config key — what changes for the tools, the sandbox and the model, and what stays contained.
resource: packages/cli/src/tui/agent.ts
tags: [cli, files, sandbox]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Adding a directory

The file tools reach the working directory and nothing above it. A monorepo sibling, a shared library checkout, a notes folder: when a task needs one, add it.

- **`/add-dir <path>`** adds it for the rest of the session; relative to the working directory or absolute. `/add-dir` alone lists what is added.
- **`--add-dir <path>`**, repeatable, adds it for one launch.
- **`additionalDirectories`** in `namzu.config.json` or `~/.namzu/config.yaml`, a list of paths, adds it for every session in the project.

## What changes

- **The tools.** `read`, `edit`, `write`, `glob`, `grep`, `ls` and the language-server tool accept an absolute path inside an added directory. Relative paths still resolve against the working directory, and a path outside every root is refused as before.
- **The sandbox.** A sandboxed run binds each added directory read-write at its own path, so a path the model was given on the host means the same thing inside. Under bwrap that is a bind mount; under seatbelt a pair of read and write rules. The sandbox's own file API is contained to the same set.
- **The model.** The environment prompt names the added directories, so the model uses them by absolute path instead of guessing at `..`.
- **`/status`** lists them under where the session may write.

## What does not change

A directory added mid-session reaches the tools from the next turn, not the running one. The kernel's `additionalDirectories` is the same list; see the SDK's `ToolContext.additionalDirectories`. Checkpoints (`/restore`) cover the working directory only.
