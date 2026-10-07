# Desktop delivery update (snapshot 5dfb097f)

`native-update.cjs` generalises the link-preview desktop updater. It replaces the desktop `app\dist` and, when they differ, the installed `@namzu/cli` (runtime `p0`) and `@namzu/sdk` (runtime `p22`) `dist` directories from a frozen build snapshot. Windows Node only.

```
node.exe native-update.cjs --source=<snapshot dir> [--meta=<dir>] (--check | --apply | --probe-only | --verify-after=<private before snapshot>)
```

The snapshot dir holds `desktop-dist`, `cli-dist`, `sdk-dist` and `HEAD`. `--meta` (default `./snapshot-meta`) holds `COMMIT`, `cli.package.json` and `sdk.package.json` taken with `git show 5dfb097f:packages/<pkg>/package.json`; `HEAD` must equal `COMMIT`.

## Modes
- `--check`: read-only. Validates source, owned processes, live state (idle tabs, drafts equal the saved drafts, no dialogs), writes a private before-snapshot, diffs the three installed manifests against the snapshot, and checks dependency equality. The receipt lists the exact changed, added and removed paths per package, classified as runtime files or build noise (`.map`, `.d.ts`).
- `--apply`: runs the check, stages `dist-stage-<stamp>` next to each changed dist (manifest-verified), lists owned processes, closes gracefully through `close-current.cjs`, waits for the desktop and every owned process (the configured electron, or node running `runtime\packages\p0\dist\bin.js`) to exit, renames each dist to `dist-before-delivery-<stamp>` and each stage to `dist`, relaunches and verifies. A failed rename rolls every package back together. A failure after the close relaunches whatever dists are in place. Never run by this task.
- `--probe-only`: read-only; installed manifests equal the snapshot, preload API, link-preview network probe.
- `--verify-after=F`: read-only; compares the running app with the private snapshot `F` and probes.

## Safety rules
- Dependencies (`dependencies`, `optionalDependencies`, `peerDependencies`) of the installed `package.json` must equal the snapshot commit's; otherwise the check and the apply refuse (a new dependency needs a junction rebuild).
- Whole-dist replacement per package, never per file. Unchanged packages are not touched.
- The runtime copies are JavaScript only and follow the package `files` negations (tests, fixtures); the snapshot is filtered the same way before it is compared or staged.
- Refuses when the desktop pid is not the configured electron, when the state has active, queued, permission or recovery work, or when everything already equals the snapshot.
- The check never closes, kills, clicks or types into the app; it only reads over CDP.
- The receipt holds counts, hashes, paths, pids and booleans; drafts and messages live only in the private snapshot.
- Do not rebuild `dist` while a run is in progress; build the snapshot first.

## Check result (artifacts/check-20261007T141405984Z.json)
- passed, no refusal; 7 open tabs in one group, every draft empty, 0 jobs, 0 terminal alerts; desktop pid 16076 with 8 electron children, no runtime node process.
- Dependencies equal for cli and sdk (cli 35.0.0, sdk 49.0.0).
- desktop: 27 changed, 6 added, 2 removed (15 runtime paths, 20 noise).
- cli: 5 changed, 0 added, 1 removed (`test-setup.js`, a stale vitest setup file in the installed copy). Changed: `commands/acp-harness.js`, `commands/desktop-host.js`, `commands/desktop-model-catalogue.js`, `integrations/harness/claude-protocol.js`, `integrations/harness/codex-protocol.js`.
- sdk: 16 changed, 2 added (`store/session-log/structured-result.js`, `utils/structured-result-json.js`), 0 removed. Changed files are under `runtime/query`, `store/session-log`, `toolsets/manager.js`, `types/session/records.js` and `utils/json-snapshot.js`.
- Build noise was empty for cli and sdk because those copies carry no maps or declarations.

## Delivery of 5dfb097f (2026-10-07)

- `--check` passed twice: seven idle tabs with empty saved drafts, identical CLI/SDK dependencies.
- `--apply` swapped Desktop, `@namzu/cli` and `@namzu/sdk` dists together (previous dists kept as `dist-before-*`), relaunched (PID 16076 → 47620, 565 ms to the CDP page) and **failed the strict comparison**:
  - two conversations gained one message each — the stopped assistant replies that f518d85f now restores from the journal, at their original positions;
  - one tab ("selamlar", 12 messages) was no longer open. The layout revision moved 733 → 734 between the last preflight and the shutdown, during the ~30 s staging copy, while the app was in use (the owner continued closing tabs afterwards, revision 742 with four tabs). No code path closes tabs on restart (only a user close or an archive retires a tab); the conversation itself remains in its project list.
- `--probe-only` afterwards passed: installed Desktop, CLI and SDK manifests equal the snapshot; link previews, images, refusals and the cached repeat work in the real main process.
- Follow-up for the script: take the protected snapshot after staging, immediately before the close, so concurrent use during the copy is not reported as a change.

## Delivery of 8b29c3cd (2026-10-07)

- The updater now re-reads and stores the protected state after staging, immediately before the close.
- `--apply` replaced Desktop and `@namzu/cli` (SDK unchanged), relaunched (PID 47620 → 2708, 369 ms) and stopped at the first post-start read because a popover was open: the owner was already using the model control.
- `--verify-after` against the pre-close snapshot: tabs (4), drafts, messages, providers and preferences equal; one conversation gained an explicit `effort: "low"` that it did not have before the close. Opening and closing the effort panel without input does not save an effort (checked in the preview with and without a model default), so this is recorded as the owner's own change made after the restart, not attributed to the update.
- `--probe-only` passed: installed Desktop, CLI and SDK manifests equal the snapshot; link previews work in the real main process.

## Delivery of c31cf547 (2026-10-07)

`--apply` passed end to end for the first time: Desktop replaced (CLI and SDK unchanged), PID 2708 → 12520 in 341 ms; tabs, focus, drafts, settings, attachments, providers, messages and preferences equal the pre-close state; installed manifests equal the snapshot; the native link-preview probe passed. Observations only: the transcript scroll range changed (wave 4 adds edit cards and separators) and the active tab's presentation entry was flushed by the graceful close.
