---
type: Reference
title: Handing a file to the person
description: The present_file tool, what it checks before it hands a file over, the shared fact it reports, and how the terminal and the desktop app show it.
resource: packages/sdk/src/tools/builtins/present-file.ts
tags: [sdk, tools, files, desktop, tui]
status: stable
generated: { by: process:claude-code, at: 2026-11-23T00:00:00Z }
---

# Handing a file to the person

`present_file` lets the model give the person a finished file to open now. Without it the model can only name a path, which is little help in the desktop app or in a remote session. It is exported as `PresentFileTool`; the CLI mounts it in every session, deferred like the other tools outside the always-sent list, so the model loads it with `search_tools` when it needs it.

## When to use it

A file the model wrote inside the person's own folder is already there: it says where it is. `present_file` is for a file that lives only in the scratch folder (the operating system's temporary directory) or in an added directory, or one the person should open right away. The tool description says this in the first lines, which is what the deferred catalogue shows.

## Input

| Field | Meaning |
| --- | --- |
| `paths` | One to ten paths of regular files. Relative paths resolve against the work folder. |
| `caption` | Optional, up to 300 characters: one line saying what the files are. |

## What it checks

Each path goes through the same resolver the file tools use (`resolveWithinAnyReal` over `toolRoots`): the work folder, directories added to the session, paths approved for the call, and the scratch folder unless `NAMZU_GUARD_TEMP_DIR=1`. A link is judged by where it ends, so a link inside the work folder that leads out is refused. After that the path must be a regular file the process can read.

| Refusal | Reason in the result |
| --- | --- |
| Outside every root | says the folders the session reaches and that the person can add the folder |
| Does not exist | `no such file` |
| A folder | `a folder, not a file`; name the files inside it |
| Not a regular file | `not a regular file` |
| Unreadable | `the file cannot be read` |
| Sandboxed run | `present_file is not available in a sandboxed run`: the files are not on the person's machine |

The good paths are shared and the refused ones are listed under *Not shared*. If nothing can be shared the call fails with every reason. Nothing is copied and no bytes go back to the model.

## What it reports

The result carries `facts: { kind: 'shared', files: [{ path, bytes }], caption? }` (`ToolFacts` in `types/tool/presentation.ts`; admitted from a saved conversation by `admitToolFacts`, and by the desktop app's own copy of that rule). The path is the one the person knows (links not followed). The same list is in `data`.

## How it is shown

- **Terminal.** One plain row: `Shared report.pdf · /tmp/out/report.pdf`, or `Shared 2 files · a.png, b.csv`. The path is plain text, which terminals that detect paths make clickable; no link sequence is written for files.
- **Desktop.** A card for each file under the reply; see [Desktop](../cli/desktop.md#a-file-the-agent-hands-over).

The tool is not served by the MCP tool server and is not in `getBuiltinTools()`, so an SDK host that wants it mounts `PresentFileTool` itself.
