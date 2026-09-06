---
type: Reference
title: Bounded file discovery
description: Explicit glob scope, incremental sandbox enumeration, cancellation and incomplete results.
resource: packages/sdk/src/tools/builtins/glob.ts
tags: [sdk, tools, sandbox, filesystem]
status: stable
---

# Bounded file discovery

`glob` searches regular files relative to its `path`, which defaults to the
working directory. `*` and `*.ts` search only that directory. Recursive discovery
requires an explicit `**`, such as `src/**/*.ts`. Braces and character classes
use the same matcher on the host and inside a sandbox. No hidden recursive
prefix is added. Enumeration skips symlink entries; an authorized local root
alias is resolved before traversal, and returned paths remain readable through
that alias, including paths from explicitly added directories.

Hidden files and directories are excluded from wildcard matches by default.
Set `include_hidden: true` to include them, or name a dotfile explicitly, such
as `.env` or `.config/*.json`. Patterns containing a `..` segment are refused.
An absolute pattern must remain inside the selected search directory. Patterns
are limited to 4,096 characters and 256 brace expansions; exceeding either bound
fails before enumeration. Expansion cannot introduce a path outside the root.
Matching and directory pruning share one parsed, per-path-component grammar,
including hidden-name behavior in grouped wildcard alternatives.

The tool reports at most 500 paths. It asks the enumerator for one additional
match so the result can distinguish a complete list from a truncated one.
`data.truncated` and an output notice identify incomplete results. A traversal
budget of 20,000 examined entries bounds sparse or unmatched recursive searches;
exhausting it returns a failure with any matches already found, not a claim
that no files exist. The tool's execution deadline is 15 seconds, and its abort
signal reaches the enumerator.

Static directory prefixes and finite pattern depth prune traversal before
directory reads. Files are yielded incrementally; the result cap is applied
during enumeration. Known file paths can be read directly. The runtime prompt
no longer requires a discovery call before every read. The tool call label
includes both pattern and directory.

## Content searches

`grep` uses the same incremental enumerator before reading file contents.
Its existing include shorthand remains recursive: `include: "*.ts"` means
`**/*.ts`, and brace filters such as `*.{ts,js}` use the shared matcher.
Choose a narrow `path` or a directory prefix in `include` to limit traversal.
Wildcard dotfiles remain included in sandbox Grep searches and excluded on
the host; explicitly named dotfiles remain searchable on either path.

Grep examines at most 20,000 filesystem entries and has a 15-second execution
deadline. It skips symlink entries, binary contents and files larger than
5 MiB (5,242,880 bytes). Enumerator size metadata rejects known oversized files
before a read; the content size is checked again after reading. This is a
per-file limit, not a total byte budget. The result limit remains 100 matching
lines by default and is configurable through `max_results`.

Reaching `max_results` closes enumeration immediately and reports
`data.truncated: true` with an incomplete-search notice: finding the requested
number of matches does not establish that the search was exhaustive. Traversal
errors, unreadable files and cancellation retain any matches already collected
and report an incomplete failure. An empty partial result describes only the
files searched. The signal reaches enumeration and host reads. A sandbox read
already in progress may settle later because `Sandbox.readFile` has no signal
parameter; its late contents are not searched, and iteration is closed.

## Sandbox enumeration

`Sandbox.walkFiles(rootPath, options)` is an optional capability returning an
async iterable of `SandboxFileEntry`. Entries contain absolute paths and byte
sizes for regular files. The selected backend owns filesystem access; the tool
does not substitute a host search for a sandbox search. Glob and Grep refuse a
sandbox without this capability and identify the required adapter update.

`SandboxWalkFilesOptions` contains:

| Field | Meaning |
| --- | --- |
| `maxEntries` | Required positive integer cap on emitted matching files. |
| `pattern` | Pattern relative to `rootPath`; default `**/*`. |
| `maxDepth` | Optional positive depth limit; immediate files have depth 1. Pattern depth can narrow it further. |
| `maxVisitedEntries` | Positive traversal-work cap; default 20,000. Exhaustion throws `ERR_FILE_WALK_LIMIT`. |
| `includeHidden` | Include hidden entries in wildcard matches; default false. Explicit dotfile patterns remain available. |
| `signal` | Caller cancellation. Iteration must stop and release owned resources. |

The local provider closes directory handles when iteration ends. A pending
filesystem operation can finish after cancellation, but it cannot schedule
further traversal; a late directory handle is closed. This does not claim
atomic protection against a path being replaced concurrently with a read.

Docker, ACI and Firecracker adapters use `walkFilesViaExec`, which accepts the
existing `SandboxFileWalkExec` function, root path and options. It runs a bounded
JSON-lines enumerator inside the backend's Node worker environment. The
compiled matching plan is shared with local enumeration. JSON framing preserves
filenames containing tabs or newlines; malformed, truncated and failed worker
results are refused. The helper requires a canonical root and refuses a root
that follows a symbolic link. Stopping iteration cancels the owned execution
and awaits its terminal observation; the supplied execution adapter must honor
the sandbox signal and cancellation-settlement contract. An unconfirmed remote
cancellation keeps the backend's existing retirement behavior.

```ts
import { walkFilesViaExec } from '@namzu/sdk'
import type { SandboxFileWalkExec, SandboxWalkFilesOptions } from '@namzu/sdk'

async function firstFile(exec: SandboxFileWalkExec, root: string) {
  const options: SandboxWalkFilesOptions = {
    pattern: 'src/**/*.ts',
    maxEntries: 1,
    maxVisitedEntries: 20_000,
  }
  for await (const file of walkFilesViaExec(exec, root, options)) return file.path
}
```

`listFiles` remains the eager enumeration API used by `ls`. The absolute-path
contract applies to both enumeration APIs: filesystem tools resolve returned
paths once, rather than appending an absolute path to the search directory again.

## Upgrade

Replace a previously recursive bare `*.ts` query with `**/*.ts`. Use
`include_hidden: true` when an older sandbox query relied on hidden files being
included. Host glob results now contain regular files only, matching the
sandbox behavior. The deadline falls from the generic 120 seconds to 15 seconds;
narrow the directory or pattern for large inventories.

Grep's execution deadline also falls from 120 seconds to 15 seconds. Its new
traversal budget can stop a broad content search before every file is read;
inspect `data.truncated` and narrow the directory or include filter when needed.

Custom sandbox adapters must implement `walkFiles` to support builtin glob and grep.
Use the matching SDK major with the sandbox package: its peer range now tracks
the SDK that exports the bounded execution helper.
