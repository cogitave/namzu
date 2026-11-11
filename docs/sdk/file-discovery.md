---
type: Reference
title: Bounded file discovery
description: Explicit glob scope, ignore files, incremental sandbox enumeration, cancellation and incomplete results.
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

Hidden files and directories are included in wildcard matches by default, in
`glob` and `grep` alike. Pass `include_hidden: false` to leave them out; a
dotfile named explicitly, such as `.env` or `.config/*.json`, still matches.
Version-control directories are always skipped, and ignore files and the
session's read rules (below) still decide what is listed. Patterns containing a `..` segment are refused.
An absolute pattern must remain inside the selected search directory. Patterns
are limited to 4,096 characters and 256 brace expansions; exceeding either bound
fails before enumeration. Expansion cannot introduce a path outside the root.
Matching and directory pruning share one parsed, per-path-component grammar,
including hidden-name behavior in grouped wildcard alternatives.

The tool reports at most 500 paths. It asks the enumerator for one additional
match so the result can distinguish a complete list from a truncated one.
`data.truncated` and an output notice identify limited or incomplete results.
A limit is a normal result, not a failure: the 500-path cap, the examined-entry
bound (see [Ignore files](#ignore-files-and-the-entry-bound)) and a spent time
budget all return `success: true` with the paths found so far and a note saying
what was cut. Only a search that ends with nothing found because its time budget
ran out, or whose walk cannot start, is an error, because "no files" would then
be untrue. The tool stops itself after 12 seconds, inside its 15-second
execution deadline, so that it can still return what it has; its abort signal
reaches the enumerator. Paths are shown relative to the working directory when
the file lies under it and absolute otherwise, without a `./` prefix; in a
sandbox they are relative to the sandbox root.

Static directory prefixes and finite pattern depth prune traversal before
directory reads. Files are yielded incrementally; the result cap is applied
during enumeration. Known file paths can be read directly. The runtime prompt
no longer requires a discovery call before every read. The tool call label
includes both pattern and directory.

The walk compiles patterns itself (`sandbox/glob-segment.ts`): braces are expanded
first (at most 256 branches), then each path segment becomes a plain name or a
regular expression covering `*`, `?`, `[...]` classes, POSIX classes, the five
extglob forms and `\` escapes, with `**` spanning any number of directories. The
same expressions run on the host and in the sandbox guest, so both see the same
files. A wildcard never matches a name starting with `.` unless hidden entries
are included or the pattern spells the dot out. A range written backwards (`[z-a]`)
matches nothing. A repeated group, `*( ... )` or `+( ... )`, is accepted only when
every alternative is a plain name and none is a prefix of another (`+(foo|bar)`,
`*(ab|cd)`), or when it holds a single `[...]` class (`+([a-z])`); each repetition
then reads one way, so matching stays linear. Any other repeated group (`*(*(a))`,
`*(a|aa)`, `+(*.ts)`, `+(a|)`, `*(?(a))`) can match the same text more than one
way and backtrack without end on a name that nearly matches, so the walk refuses it
before touching the filesystem or building the guest script: `glob` and `grep` return
a tool error, "The pattern '<segment>' repeats a group that can match the same text
more than one way; use ** or {a,b} instead." (`GlobTooComplexError`). `@( )`,
`?( )` and `!( )` are unchanged, but a repeated group inside them follows the same
rule. A segment with more than three wildcards that can stretch (each `*`, `*( )` and `+( )`, consecutive `*` counted once; a whole-segment `**` is a path globstar and is not counted) is refused the same way, with "The pattern '<segment>' has more than three wildcards that can stretch; split it across folders or use fewer *.", because matching a long name against four or more of them takes seconds. A segment longer than 1,024 characters (`MAX_GLOB_SEGMENT_LENGTH`; a file name is at most 255 bytes, and compiling takes time in proportion to the square of the length) is refused first, before any of that work, with "The pattern '<first 60 characters>...' is too long (<n> characters; at most 1024 between slashes); shorten it or split it across folders." The whole pattern is already limited to 4,096 characters and 256 brace branches before it is split. A POSIX class name that `Object.prototype` also has, such as `[[:constructor:]]`, is an unknown name like any other and is read as ordinary characters. The answers of the segment compiler are recorded as language-neutral vectors in `conformance/glob-segment/vectors.json`, regenerated with `node --import tsx scripts/generate-conformance-vectors.mjs`; see `conformance/README.md`. The few forms where the answer differs from minimatch 9 are pinned in
`glob-segment.test.ts`.

## Content searches

`grep` uses the same incremental enumerator before reading file contents.
Its existing include shorthand remains recursive: `include: "*.ts"` means
`**/*.ts`, and brace filters such as `*.{ts,js}` use the shared matcher.
Choose a narrow `path` or a directory prefix in `include` to limit traversal.
Wildcard dotfiles remain included in sandbox Grep searches and excluded on
the host; explicitly named dotfiles remain searchable on either path.

Grep stops itself after 12 seconds, inside a 15-second execution deadline, and
after reading 50,000 files. It skips symlink entries, binary contents and files
larger than 5 MiB (5,242,880 bytes). Enumerator size metadata rejects known
oversized files before a read; the content size is checked again after reading.
This is a per-file limit, not a total byte budget.

On the host file system (not a sandbox, where each read goes through the adapter
as before) `grep` resolves the real path of each directory once and checks it
against the real root, then reads a file through one handle: open with links
refused at the last component, `fstat` for the regular-file check and the size,
read, close. The size comes from that handle, so the host walk does not stat each
file first, and a file over the cap, or one deleted after it was listed, is
skipped (the latter as if never listed), not counted as unreadable. Directory
listing and reads are batched and yield to the event loop every few
milliseconds, and the walk runs ahead of the matching so the two overlap; a
cancellation is seen between files. Results and their order are unchanged. Results are paged: the
default `head_limit` is 250 entries (`0` for none), and `max_results` is its
deprecated alias.

A full page, a spent time budget with matches, the entry bound, the file bound
and unreadable files are normal results (`success: true`) with a note saying what
was cut; `data.truncated` is true, `data.incomplete` is true when the search did
not reach every file, and the facts carry `limited` or `incomplete`. A file list
is ordered newest first, so the walk cannot stop at the first page: it reads
until it has `offset + max(head_limit * 4, 1000)` matching files, then sorts and
pages, and says so; the count includes the offset, so every offset the note offers
can be served (the newest-first order is among the files read, which can differ
slightly between pages on a very large result). Walk errors and cancellation retain any matches already collected
and report an incomplete failure. An empty result says how many ignored
directories were skipped. The signal reaches enumeration and host reads. A
sandbox read already in progress may settle later because `Sandbox.readFile` has
no signal parameter; its late contents are not searched, and iteration is closed.

## Ignore files and the entry bound

Unless `include_ignored: true` is passed (on `glob` and `grep` alike), both tools
skip what `.gitignore`, `.ignore` and `.git/info/exclude` exclude, and on the
host the global git ignore file (`$XDG_CONFIG_HOME/git/ignore`, or
`~/.config/git/ignore`; `core.excludesFile` is not queried). Version-control
directories (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`) are never entered.

- Rule files count at every level: the search root, every directory below it and
  every ancestor up to the enclosing repository. A deeper file beats a shallower
  one, `.ignore` beats `.gitignore` in the same directory, the last matching line
  wins, and `!` re-includes a file unless a parent directory is excluded.
- `.gitignore` applies only inside a git repository (a `.git` directory or file
  at or above the root); `.ignore` always applies. A nested checkout, such as a
  worktree, is a boundary of its own: the parent's rules can still prune it, and
  if they do not, its own `.gitignore` applies inside it. When the search root
  lies above several repositories, each applies its own rules as the walk enters
  it.
- A search root named on purpose is never itself ignored: `path: packages/sdk/dist`
  searches `dist`, and a pattern such as `dist/**/*.js` starts its walk at `dist`.
- A rule the matcher does not understand is dropped, so a visible file is never
  hidden by one: an unclosed `[`, or more than three separate `*` in one rule,
  whose match could backtrack for seconds on a long name. An ignore file is read up to 256 KiB and 10,000 rules.
- The walk examines at most 500,000 entries (about 17 seconds of walking). Reaching
  it ends the walk with the entries found so far and `SandboxWalkSummary.stopped:
  'entry-limit'`; the tools turn that into a normal result with a note. Ignore rules
  cut this repository's walk from 24,229 entries to 8,448.

The matcher is the SDK's own, about 150 lines with no dependency, and the same
source text runs on the host and inside the sandbox guest program, which is
shipped as a single `node -e` argument and cannot import a package. It is tested
against `git check-ignore` over a generated corpus of rules and paths.

`glob` honours ignore files by default on purpose: a pattern that lists build
output or dependencies is almost never asking for it, and `include_ignored: true`
restores the old listing. `ls` and `listFiles` are not searches and keep naming
ignored entries (`respectIgnore: false`).

## Hidden files and read rules

Searching hidden files is safe because two things keep secrets out. A `.env`
is normally in `.gitignore`, so the ignore rules above leave it out; and a
file the session's read rules deny is neither listed nor opened. The executor
gives each tool call `ToolContext.readDenied(absolutePath)`, which asks the
turn's authorization gate what the `read` tool would be told for that path.
`grep` asks before it opens a file and `glob` before it lists one, so a denied
file is absent from the result and its contents are never read, on the host and
in a sandbox (a sandbox path is mapped to the same place under the working
directory, and a path outside the folder the sandbox binds is denied). A host
that supplies no gate gets no filtering. The CLI therefore
lets `grep` and `glob` search a folder that holds a denied file, where it used
to refuse the whole search; `ls`, which has no per-file filter, still refuses
an ancestor of a path that `read` denies. The walk still opens the ignore files
(`.gitignore`, `.ignore`) of a directory it enters and lists its entries, even
inside a denied directory; their contents are never returned, and only files are
filtered.

When the search root is a home directory, hidden caches (`~/.cache`, `~/.npm`,
`~/.local`) are walked like any folder. A walk that outlasts the 12-second
budget returns the matches found so far as a normal result with the "stopped
early" note; it is an error only when it found nothing.

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
| `maxVisitedEntries` | Positive traversal-work cap; default 500,000. Exhaustion ends the walk and reports `stopped: 'entry-limit'` to `onSummary`; with `failOnLimit` it throws `ERR_FILE_WALK_LIMIT` instead. |
| `failOnLimit` | Throw `ERR_FILE_WALK_LIMIT` at `maxVisitedEntries` instead of ending; default false. |
| `respectIgnore` | Skip what `.gitignore`, `.ignore` and `.git/info/exclude` exclude; default true. The guest reads the ignore files itself, so the host sends no rules. |
| `onSummary` | Called once when the walk ends with `{ visited, ignoredDirectories, stopped? }`. |
| `includeHidden` | Include hidden entries in wildcard matches; default false for a direct walk (`grep` and `glob` pass true unless `include_hidden: false`). Explicit dotfile patterns remain available. |
| `signal` | Caller cancellation. Iteration must stop and release owned resources. |

The local provider closes directory handles when iteration ends. A pending
filesystem operation can finish after cancellation, but it cannot schedule
further traversal; a late directory handle is closed. This does not claim
atomic protection against a path being replaced concurrently with a read.

Docker, ACI, Firecracker and Kubernetes adapters use `walkFilesViaExec`, which accepts the
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
    maxVisitedEntries: 100_000,
  }
  for await (const file of walkFilesViaExec(exec, root, options)) return file.path
}
```

`listFiles` remains the eager enumeration API used by `ls`. The absolute-path
contract applies to both enumeration APIs: filesystem tools resolve returned
paths once, rather than appending an absolute path to the search directory again.

## Upgrade

Replace a previously recursive bare `*.ts` query with `**/*.ts`. `grep` and
`glob` now include hidden files by default; pass `include_hidden: false` for the
old host behavior. Host glob results now contain regular files only, matching the
sandbox behavior. The deadline falls from the generic 120 seconds to 15 seconds;
narrow the directory or pattern for large inventories.

Grep's execution deadline also falls from 120 seconds to 15 seconds. Its new
traversal budget can stop a broad content search before every file is read;
inspect `data.truncated` and narrow the directory or include filter when needed.

A walk no longer fails when it reaches its entry bound, and the default bound is
500,000 entries, not 20,000. Pass `failOnLimit: true` for the previous thrown
`ERR_FILE_WALK_LIMIT`. Ignored files are skipped by default; pass `include_ignored:
true` to `glob` or `grep` (or `respectIgnore: false` to a walk) to see them again.
Paths in `glob` and `grep` results no longer start with `./`.

Custom sandbox adapters must implement `walkFiles` to support builtin glob and grep.
An adapter that does not delegate to `walkFilesViaExec` should honour `respectIgnore`
and `onSummary`; the sandbox conformance suite checks both.
Use the matching SDK major with the sandbox package: its peer range now tracks
the SDK that exports the bounded execution helper.
