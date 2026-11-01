---
'@namzu/sdk': major
'@namzu/sandbox': minor
---

`grep` and `glob` now skip files that `.gitignore`, `.ignore` and `.git/info/exclude` exclude (and never enter `.git`), and a limit no longer fails a search. Before, a repository with build output or a nested worktree could not be searched at all: the walk stopped at 20,000 examined entries and returned "File search stopped after examining 20000 entries" as an error.

What changes for a caller:

- Ignored files are no longer returned. To search them, pass `include_ignored: true` to `grep` or `glob`; for a direct walk pass `respectIgnore: false`. A search root named on purpose is never itself ignored, so `path: packages/sdk/dist` still searches `dist`.
- Reaching a limit (a full page, the 500-path `glob` cap, the examined-entry bound, the time budget with matches found, unreadable files) now returns `success: true` with the results found so far and a note saying what was cut. `data.truncated` stays true; `data.incomplete` and the `limited` / `incomplete` facts say which kind. Only a search that ran out of time with nothing found, or whose walk cannot start, is still an error. If you branched on `success === false` to detect a partial search, read `data.truncated` and `data.incomplete` instead.
- The examined-entry bound moves from 20,000 to 500,000 and `walkFilesLocally` / `walkFilesViaExec` no longer throw `ERR_FILE_WALK_LIMIT` by default: they end the walk and report `{ stopped: 'entry-limit' }` through the new `onSummary` option. To keep the thrown error, pass `failOnLimit: true`. A `Sandbox.walkFiles` implementation that does not go through `walkFilesViaExec` should honour `respectIgnore` and call `onSummary`.
- `grep` and `glob` paths are relative to the working directory when the file lies under it and absolute otherwise, without a `./` prefix. Code that stripped `./` can stay; code that required it must stop.
- `glob` and `grep` stop themselves after 12 seconds, inside the existing 15-second tool deadline, so they can return what they found. A file list stops reading at `offset + max(head_limit * 4, 1000)` matching files before it sorts newest first, so every offset the note offers can be served.

The ignore matcher is the SDK's own, with no new dependency: the sandbox guest program travels as one `node -e` argument and cannot import a package, so the host and the guest run the same source text. It is tested against `git check-ignore` over a generated corpus. A global `core.excludesFile` setting is not queried; the default global ignore file is read on the host.

A rule with an unclosed `[`, or more than three separate `*`, is dropped (the latter could make one name take seconds to test). `glob` honouring ignore files is deliberate: `include_ignored: true` gives the old listing. Host `grep` still skips hidden files, as before, because the host has no read filter for secrets.

`@namzu/sandbox` (minor): the public `testing` conformance suite gained mandatory cases (ignore rules, the bound's summary, and that `listFiles` names ignored files), so an existing third-party backend that does not honour `respectIgnore` or `onSummary` in `walkFiles`, or whose `listFiles` hides ignored files, can now fail it; its limit case passes `failOnLimit: true`. The Pal computer's `listFiles` (and so `ls`) still lists ignored entries and still throws past its bound.
