---
type: Reference
title: Kernel facts - the data epoch and the desktop contract
description: The two numbers a host states in initialize (kernel.dataEpoch, kernel.desktopContract), the inventory of every on-disk format a kernel writes and of what an installed desktop application relies on, the tests that guard both, and when to raise each number.
resource: packages/sdk/src/constants/data-epoch.ts
tags: [sdk, cli, desktop, protocol, storage, compatibility]
status: stable
generated: { by: process:agent, at: 2026-11-12T00:00:00Z }
---

# Kernel facts: the data epoch and the desktop contract

An application that keeps its own copy of the engine up to date has to decide, before it runs a newer copy,
whether that copy is safe for it. The host answers that in `initialize`. This page explains the two numbers it
states, what each one protects, the inventories behind them, and the tests that make changing either on
accident hard. The bridge itself is described in [Agent client protocol](agent-client-protocol.md); the
application that reads the numbers is the [Desktop application](../cli/desktop.md).

## What `initialize` says

The answer to `initialize` carries one optional object:

```json
"kernel": { "engine": "62.13.0", "dataEpoch": 1, "commandLine": "51.1.0", "desktopContract": 1 }
```

| Field | Present | Source |
|---|---|---|
| `engine` | always | the SDK's own version (`VERSION`) |
| `dataEpoch` | always | `DATA_EPOCH`, an exported integer constant in the SDK |
| `commandLine` | when the host application says it | the host's `kernelFacts.commandLine`; `namzu acp` always says it |
| `desktopContract` | when the host application says it | the host's `kernelFacts.desktopContract`; only `namzu acp --desktop` says it, with `DESKTOP_CONTRACT` |

The SDK does not know which application hosts it. `ACPServer` takes an optional `kernelFacts`
(`AcpHostKernelFacts`: `commandLine`, `desktopContract`), and answers with only the fields it is given. A host
that gives nothing answers `{ "engine": ..., "dataEpoch": ... }`. The types `AcpKernelFacts` and
`AcpHostKernelFacts` are exported. A reader that does not know the object ignores it: the desktop application
reads `agentInfo.name`, `extensions`, `promptAttachments` and `promptOptions` by name and nothing else, and
nothing else in this repository validates the answer strictly.

## The data epoch

`DATA_EPOCH` (`packages/sdk/src/constants/data-epoch.ts`, starts at 1) says which generation of on-disk formats
an engine writes. Two engines with the same epoch can read and write each other's files. The desktop
application uses a newer engine it fetched itself only when its epoch equals the one inside the installer, so a
data format change reaches a person with an app release, and going back to the bundled engine can never strand
a conversation.

**Raise it** when an older engine can no longer safely read or write what this one writes: a stamped store
moves to a version the older one refuses, a format gains a field the older engine would drop and write back
without, or misread, or a file is renamed or moved. **Do not raise it** for a change an older engine ignores or
reads the same way. If you are unsure which it is, read the row for the format below: "an older engine meets a
newer one" says what happens today.

### The guard

Two tests list every stamped format with its current version:
`packages/sdk/src/__tests__/data-epoch-guard.test.ts` (the engine) and
`packages/cli/src/data-epoch-guard.test.ts` (the command line). Each scans its source for every
`const ...VERSION = <integer>`, every `defineSchema({ kind, current })` and a listed set of literal stamps. A
version that changes, appears or disappears fails with the rule: raise `DATA_EPOCH` when an older engine can no
longer safely read or write what this one writes; otherwise record the new value in the table and say why in the
same commit. The SDK test also records `DATA_EPOCH` itself, so raising it is a visible edit in two places.

The command line's test also lists the stamps of the capability packages it ships with (browser profiles,
the analysis cache). What the scan cannot see: a format stamped some other way than the three above, and a format with no stamp.
The first is added to the literal list when found. The second is the next section.

### Formats with no stamp

A format without a stamp is read by shape. What an older kernel does with a newer file then depends on the
reader: one ignores a field it does not know, another drops it when it rewrites the file, another treats a file
it cannot parse as absent and the next write replaces it. Nothing says "this file is from the future". The rule
for these: **a change to an unstamped format that an older kernel would misread or overwrite is a reason to
raise `DATA_EPOCH`, and the test cannot tell you so.** Adding a field an older reader ignores and never rewrites
is not. This change adds no stamps; where a format below says "none", that is the risk in plain words.

### Inventory

"Under `$HOME`" means `NAMZU_HOME` (default `~/.namzu`). Behaviour is read from the code at the time of writing;
a row that says "not checked" was not read.

Stores stamped through `defineSchema` (field `schemaVersion`) all follow `migrate` in
`packages/sdk/src/store/schema.ts`: a record from a newer schema is refused with a `SchemaVersionError` rather
than read, because reading it would drop the fields this build does not know and writing it back would lose them.

#### The session tree (engine)

| Format | Where | Written by | Stamp | An older engine meets a newer one |
|---|---|---|---|---|
| Session log | `projects/<slug>/<session-id>.jsonl`, and `<id>/subagents/<child>.jsonl` | engine, one writer at a time under the lease | `v` on every record (`SESSION_RECORD_SCHEMA_VERSION` = 1), hash-chained | refuses a record with another `v`; an unknown record type is kept only when the writer marked it `ignorable`, otherwise refused |
| Child session meta record | `<id>/subagents/<child-id>.meta.json` | engine, when a delegated run starts and ends | `v: 1`, `kind: 'child-session'` (strict) | refuses the file when it is parsed (`ChildSessionMetaSchema`); the child's own log wins, so the record is a convenience copy |
| Session lease | `<id>/lease.json` (a view) and `lease.<fence>.json` | engine | `v: 1`, `kind: 'lease'` | not checked beyond the shape check |
| Spill manifest and body | `<id>/tool-results/` | engine | `v: 1`, `kind: 'spill'` (log spills); `version: 1` (tool result spills) | not checked beyond the shape check |
| Checkpoint | `<id>/checkpoints/<id>.json` | engine | `v` (`CHECKPOINT_DOCUMENT_VERSION` = 1) | refuses: "Unsupported checkpoint version" |
| Token budget | `<id>/budgets/<turn>.json` | engine | `v` (`SESSION_TOKEN_BUDGET_VERSION` = 2) | refuses: "Unsupported token budget snapshot version" |
| Turn state | with the session | engine | `version` (`TURN_STATE_VERSION` = 1) | refuses with `TurnStateVersionError` |
| Tasks | `<id>/tasks/<id>.json` | engine | `schemaVersion` (`task-store` 2) | refuses a newer record (`SchemaVersionError`) |
| Goals | `<id>/goals/<id>.json` | engine | `schemaVersion` (`session-goal` 2) | refuses a newer record |
| Feedback | `<id>/feedback/<id>.json` | engine | `schemaVersion` (`feedback-store` 1) | refuses a newer record |
| Plan | `<id>/plans/plan.md` | engine | none | reads as text |
| File history | `<id>/file-history/` | engine | not checked | not checked |
| Session store files | `session.json`, `subsession.json`, `summary.json` | engine | `schemaVersion` (`session-store` 4) | refuses a newer record |
| Project document | `projects/<slug>/project.json` | engine, minted once | `v: 1`, `kind: 'project'` | not checked beyond the shape check |
| Root path index | `projects/root-path-index.json` | engine | not checked | not checked |
| Session index | `index.sqlite` | engine; derived from the logs | `PRAGMA user_version` (`SESSION_INDEX_VERSION` = 1) | any other version is rebuilt from the logs, never migrated |
| Memory | `projects/<slug>/memory/` (`index.json`, markdown notes) | engine and command line | `schemaVersion` (`memory-store` 1, `markdown-memory` 1; markdown records none while at 1) | refuses a newer record |
| Topic state and objective | topic directories | engine | `schemaVersion` (`topic-state` 1, `topic-objective` 1) | refuses a newer record |
| Scratch space | `$TMPDIR/namzu-<user>/<slug>/<session>/scratchpad/` | engine | none | scratch, not read back across engines |

#### Home level files (engine)

| Format | Where | Written by | Stamp | An older engine meets a newer one |
|---|---|---|---|---|
| Accounts | `accounts.json`, `accounts/` | engine | `version` (`ACCOUNTS_FILE_VERSION` = 1) | refuses the file ("no account was changed"); unknown keys inside a known version are kept on rewrite |
| Learning store | `learning.sqlite` (home, project and per-conversation copies) | engine and command line | `PRAGMA user_version` (`LEARNING_STORE_VERSION` = 3) | refuses: "this store reads version 3 only" |
| Learning experience store | `experience.sqlite` | command line | `PRAGMA user_version` (`LEARNING_EXPERIENCE_STORE_VERSION` = 1) | refuses |
| Learning guidance | `state.json` beside the store | engine | `schemaVersion` (`learning-guidance` 1; an earlier `resident-agenda` 6 is read to migrate) | refuses a newer record |
| Peer records | per-terminal record files | engine and command line | `v` (`PEER_RECORD_VERSION` = 1) | not checked beyond the shape check |
| Turn outcome snapshot | with the turn | engine | `v` (`SNAPSHOT_VERSION` = 1) | an unknown version reads as no snapshot |
| Pal definitions | pal store, `revisions/<n>.json` | engine and command line | `v: 1` | refuses the revision |
| Pal communication, activity, channels | `state.json`, `permission.json`, `subscription.json`, `route.json` | engine | `schemaVersion` (`pal-communication` 2, `pal-message-operation` 2, `pal-message-permission` 1, `pal-activity-subscription` 1, `pal-activity-subscription-permission` 1, `pal-channel-route` 1) and `v: 1` records | refuses a newer record |
| Shared session workspace | manifest of a shared workspace | engine | `schemaVersion: 1` | not checked beyond the shape check |
| Harness session journal | harness session directory | engine | `v: 1` | not checked beyond the shape check |
| Retention archive | `archive.json`, `messages.jsonl`, `summary.json`, `workspace.json` | engine | none seen | reads by shape |
| Workflow journal | `runs/<id>/workflow/journal.jsonl` | engine and command line | none; a `prev` hash chain | reads by shape |

#### Home level files (command line)

| Format | Where | Written by | Stamp | An older command line meets a newer one |
|---|---|---|---|---|
| Provider preferences | `preferences.json` | command line | `version` (`PREFERENCES_FILE_VERSION` = 3) | reads as "needs re-pick" (unsupported version); version 1 and 2 are migrated |
| Credentials | `credentials.json`, `api-keys.json`, `gemini-api-key.json` | command line | `version` (`CREDENTIALS_FILE_VERSION` = 1) | a record of another version reads as no key; the next save replaces the file |
| Trusted folders | `trust.json` | command line | `version` (`TRUST_FILE_VERSION` = 1) | not checked beyond the shape check |
| Acknowledgements | `acknowledgements.json` | command line | `version` (`VERSION` = 1) | not checked beyond the shape check |
| Tool server approvals | `mcp-approvals.json` | command line | `version` (`FILE_VERSION` = 1) | not checked |
| Tool server sign-ins | `mcp-oauth/<endpoint>.json` | command line | `version: 1` | a record of another version is ignored |
| Plugin settings | `plugin-settings/<plugin>.json` | command line | `version: 1` | a record of another version is ignored |
| Window layout | `workspaces.json` | command line | `version` (3; 1 and 2 are migrated) | a layout of another version reads as no layout; the next save replaces it |
| Memory usage | `memory-usage/<project>.json` | command line | `version` (`VERSION` = 1) | a record of another version is ignored |
| Spend ledger | `spend-ledger.json` | command line | `version` (`SPEND_LEDGER_VERSION` = 2) | a derived summary of the session logs; a missing, unreadable or other-version file is rebuilt from the logs, never migrated, and an older command line ignores it |
| Model cache | `cli/` model cache | command line | `version` (`VERSION` = 1) | a cache of another version is ignored |
| Catalogue snapshots | `cli/zen-catalogue.json`, `zen-catalogue-failed.json` | command line | none seen | read back by shape; a cache |
| Skill suggestions | `skills/.suggestions.json` | command line | `v: 1` | not checked |
| Learning generator | `generator.json`, `generator.lock` | command line | `version: 1` | not checked |
| Update state | `attempt-<install>.json`, `previous/` copies | command line | none | read by shape; the updater never acts on a kernel an application manages (see below) |
| Memory notes | `MEMORY.md`, `USER.md`, typed memory `index.json`, `curation.jsonl`, `.namzu/MEMORY.md` in a project | command line | none | markdown and plain line logs; read by shape |
| Checkpoint manifest | checkpoints directory `turns/<id>.json`, `blobs/` | command line | `version` (`MANIFEST_VERSION` = 1) | a manifest of another version reads as absent |

#### Scheduled tasks (command line), under `schedule/`

| Format | Where | Stamp | An older command line meets a newer one |
|---|---|---|---|
| Job | `jobs/<id>.json` | `v` (`SCHEDULE_FORMAT_VERSION` = 3; 1 and 2 still written for jobs that use no newer feature), `kind: 'schedule-job'` | refuses a job above the version it knows (`ScheduleFormatError`) |
| State, claims, run results | `state/`, `claims/`, `runs/<id>/<run>.json` | `v` and `kind` | refuses a higher `v` |
| History | `history/<id>.jsonl` | `v` 1, 2 or 3 on each line | a line of another version is skipped |
| Daemon files | `daemon/lease.<fence>.json`, `endpoint.json`, `heartbeat.json`, `log/daemon-<day>.jsonl` | `v: 1` (endpoint and others), none on the plain logs | not checked |
| Service record, seen marker, environment | `service.json`, `seen.json`, `daemon.env` | `v: 1` on `service.json`; none on the others | not checked |
| Script state and source deliveries | `store/script-state.ts`, delivery records | `v: 1` | not checked |
| Session loops | loops file of a session | `v: 1`, `kind: 'session-loops'` | not checked |
| Notification throttle | schedule notify file | `v: 1` | not checked |

#### Capability packages

The optional packages write a few things of their own. The command line ships with three of them, so the guard
for their stamps sits in `packages/cli/src/data-epoch-guard.test.ts` (`CAPABILITY_STAMPS`).

| Format | Where | Written by | Stamp | An older package meets a newer one |
|---|---|---|---|---|
| Browser profile descriptor | `browser/profiles/<name>.json` (mode 0600; the directories 0700) | `@namzu/browser` | `v: 1` | refuses: "The descriptor of browser profile is not readable"; the browser's own user data directory next to it is the browser's format |
| Browser profile lease | `browser/leases/<name>/<pid>-<session>.json` | `@namzu/browser` | `v: 1` | not read for its version; a lease whose process is gone is swept |
| Analysis index cache | a cache directory, one SQLite file per project root | `@namzu/analysis` | the version is in the file name (`SCHEMA_VERSION` = 3) and in a `schema` row | a file of another version is simply a different file; an older package builds its own and never reads the newer one |
| Computer-use helper | `computer-use/cua-driver/<version>/`, a downloaded program, checked before use | `@namzu/computer-use` | the pinned version is the directory name | a newer package downloads its own version beside it; only the cache directory is pruned of older ones, never a newer one |
| Computer setup state | `setup/` under the home (or `%LOCALAPPDATA%\Namzu\setup` on Windows): `image.json` (the image the computer was built from) and a restart marker | `@namzu/sandbox` | none; read by shape | a record that does not parse, or lacks a known field, reads as nothing recorded and the setup step runs again. This is the unstamped risk in plain words: a newer kernel that adds a step name an older one does not know makes the older one drop the marker |
| Remote sandbox backends (Docker, Kubernetes, Firecracker, container instances) | inside the sandbox, never under the home | `@namzu/sandbox` | none | not on the person's disk; a seed marker lives in the sandbox's own `.namzu/seed/` |
| Local file store | a folder chosen by the caller, one file per key | `@namzu/files` | none | plain bytes, no format of its own; the caller owns the layout |

#### Inside a project folder

| Format | Where | Written by | Stamp | Older kernel |
|---|---|---|---|---|
| Project config | `namzu.config.json` | the person | none | read by shape |
| Project memory | `.namzu/MEMORY.md` | command line | none | text |
| Local permission settings | `.namzu/` local settings | command line | none | read by shape |

#### Not covered

Credentials of other programs that this one only reads, a package's own `package.json`, and files a person writes
(skills, commands) are not formats the kernel owns. Rows marked "not checked" were not read when this page was
written; a change to one of them is a reason to read the code and complete the row.

## The desktop contract

`DESKTOP_CONTRACT` (`packages/cli/src/desktop-contract.ts`, starts at 1, also exported from the package entry) is
told by `namzu acp --desktop` as `kernel.desktopContract`. The application is built with the range it accepts
and uses a newer command line only when the number is inside it.

**Raise it** only for a change an already installed application cannot live with: a method it requires or
probes removed or renamed, a notification it consumes renamed, a shape it validates strictly changed so that its
copy rejects it, a flag it passes refused, the folder layout it reads versions from moved, or something it hands
to the kernel (a resource folder, an environment variable) no longer meaning what it did. **Record the new value
without raising** for an addition an older application ignores (a new optional method, a new field it does not
read).

### The inventory

One data file holds it: **`packages/cli/desktop-contract/inventory.json`**. A Desktop test can read it from the
repository. It records, as read from `packages/desktop/src`:

- the `initialize` request the application sends and the fields it reads from the answer (`initialize`);
- the core ACP methods it uses (`coreMethods`);
- the nine extension methods it requires, without which it refuses the host (`requiredMethods`);
- the optional groups it probes, each a feature that is simply off when any method of the group is missing
  (`optionalGroups`: tasks, Pal communication, conversation actions, archived conversations, terminals,
  provider setup, project git, project pull request, tool servers, conversation search, untrust, project
  changes, turn retry, abandon of a paused turn, undo, live input, Pals, Pal inbox, Pal computer control);
- the methods it calls without probing (`otherMethods`);
- the notifications it consumes, and the request the host sends it (`notifications`);
- the flags it passes: the host's `acp --desktop`, the terminal UI's `--provider --model --effort
  --permission-mode --message`, and the short `computer status | setup | stop-idle` commands (`flags`);
- the files it reads from the kernel folder: `dist/bin.js`, `package.json` and
  `node_modules/@namzu/sdk/package.json`, both for their `version` (`kernelFolder`);
- what it hands to the kernel: `ELECTRON_RUN_AS_NODE`, `NAMZU_PAL_COMPUTER_ENGINE` and
  `NAMZU_PAL_COMPUTER_BUNDLE` (a folder with a `manifest.json` naming the image), and `NAMZU_HOME`, which both
  read (`environment`);
- a digest per exported shape of the three small files the application mirrors by hand (`shapes`):
  `src/terminal/protocol.ts`, `src/commands/desktop-usage-feed.ts` (the notification and its shape) and
  `src/commands/desktop-outcome-feed.ts`.

The speech runtime runs inside the application and hands the kernel nothing, so it has no row.

### The guard

`packages/cli/src/desktop-contract.test.ts` starts the host in this process the way `namzu acp --desktop`
builds it (`desktopServerExtensions` is the one place the table is assembled) and checks meaning, not text:

- every recorded method, in every group, is offered by the host; a removal or a rename fails;
- every recorded notification name equals the constant the host sends it under;
- the terminal methods the application probes as one group are exactly the host's terminal methods;
- `acp --desktop` is accepted by the host's own argument parser (`parseAcpArgs`, which the command's handler
  uses) and any other argument refused; each terminal UI flag is an option line of the program's generated help,
  and `--permission-mode` refuses a word it does not know; every permission word the application passes is one `--permission-mode` takes; the
  `computer` verbs and flags are documented;
- the files exist where the application reads them; the Pal computer folder is read as the application
  provides it; the engine names are still the ones the host accepts;
- a `desktop` host answers `kernel.desktopContract` equal to `DESKTOP_CONTRACT`, a plain host answers none, and
  `DESKTOP_CONTRACT` equals the number recorded in the inventory;
- each mirrored shape matches its recorded digest. The digest is taken over the printed declaration with
  comments and formatting removed, so a comment or a formatting edit does not move it, and a changed member or
  a renamed constant does.

A failure states the rule: breaking for an already installed application means raise `DESKTOP_CONTRACT` (and
record it in the inventory); additive means record the new value in the inventory. The failure prints the new
digest.

What the test does not do: it does not read the application's own source, so a name the application starts using
is not in the inventory until someone adds it, and the sets in `rpc-client.ts` are not compared with the file.
A Desktop test that reads the inventory and compares it with `REQUIRED_EXTENSIONS` and the probe lists is the
other half and is not part of this change.

## The command line's own updater and a managed kernel

The terminal's background updater classifies where the running copy lives and replaces only layouts it owns.
A copy inside the installer (`.../resources/cli`) was already classified `desktop` and left alone. A kernel the
application keeps in its own data folder, `<app data>/kernel/versions/<version>`, is classified `desktop` as
well, on Windows-style and POSIX paths, whether it runs under the application's own program (the Electron flag)
or a plain node. `desktop` is a silent kind: nothing is checked, announced or replaced
(`packages/cli/src/integrations/auto-update/install-kind.ts`, with tests).

## When to touch what

| You changed | Do |
|---|---|
| A stamped format's version, or added a stamped format | update the guard table; raise `DATA_EPOCH` if an older engine can no longer safely read or write it |
| An unstamped format an older kernel would misread or overwrite | raise `DATA_EPOCH`; add a stamp in a later change |
| Removed or renamed a method, notification or flag in `inventory.json` | raise `DESKTOP_CONTRACT` and record it; changeset says what an installed app must do |
| Added a method, group or notification the app will use later | record it in `inventory.json` |
| Changed a mirrored shape | if the installed app's copy would reject it, raise `DESKTOP_CONTRACT`; record the digest |
