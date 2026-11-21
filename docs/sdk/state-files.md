---
type: Reference
title: State file locks and recovery copies
description: The lock-file protocol for small files several processes change, and the recovery copies kept in the Namzu home before such a file is replaced or when it cannot be read.
resource: packages/sdk/src/utils/file-lock.ts
tags: [sdk, storage, locks, backups]
status: stable
generated: { by: process:claude-code, at: 2026-11-21T00:00:00Z }
---

# State file locks and recovery copies

A few small files in the Namzu home are changed by more than one process: the
terminal, the Desktop engine, `exec` and Desktop itself can run at the same time.
Each such change reads the file, edits it and writes it back, so two processes that
do it together would lose one change. The SDK gives one lock for that and one set of
recovery copies. The CLI uses both for its own state files; see
[Session storage](../cli/session-storage.md#state-files-several-processes-change).

## The lock

`withFileLockSync(lockPath, operation, { attempts?, wait? })` and its async form
`withFileLock` run `operation` while holding the lock file at `lockPath`.
`lockPathFor(file)` is `<file>.lock`, the name every writer of a file uses.

The protocol is the contract between writers, including ones that cannot load the
SDK (Desktop keeps a copy in `packages/desktop/src/main/engine-state-file.ts`):

- The lock is created exclusively (`'wx'`) with mode 0600. Its whole body is
  `<pid>:<epoch ms>:<24 hex digits>`.
- A lock whose recorded pid no longer exists is reclaimed. Reclaimers are serialised
  by `<lock>.reclaim`, whose body is the reclaimer's pid, and the lock is read again
  under that guard, so a lock a live owner took in the meantime is never removed.
  There is no age limit: a slow live owner keeps its lock.
- A held lock is refused with a `FileLockError` (it carries `lockPath`), unless the
  caller passes `attempts` and a `wait` function, which runs between attempts.
- The owner removes the lock when it is done, and only while the lock still holds its
  own body.

The account registry's locks follow the same protocol: `withAccountLock`,
`withAccountLockSync` and `withAccountRefreshLock` (see [Accounts](accounts.md)) now
run on it, and `AccountLockError` is a `FileLockError`, so a caller can catch either.

## Recovery copies

Copies live in `<home>/backups/` (`stateBackupsDir(home)`, mode 0700). Every copy is
written with mode 0600 whatever the source's mode, through a flushed temporary file
and a rename, and its mode is checked afterwards; a copy that stays readable by others
is removed.

| Name | Written by | Kept |
|---|---|---|
| `<file>.backup.<epoch ms>` | `backupStateFile(file, { home, now? })`, just before a write | At most one per `STATE_BACKUP_MIN_INTERVAL_MS` (60 s) per file; the newest `STATE_BACKUP_KEEP` (5). No copy is taken when it would equal the newest one, or when the file does not exist yet. |
| `<file>.corrupt-<epoch ms>` | `preserveUnreadableStateFile(file, { home, now? })`, before a write over a file that could not be read is refused | One per distinct content (the same damage met again returns the existing copy, with `fresh: false`); the newest 5. |

`backupStateFile` never throws: a copy that could not be taken does not stop the
write it was protecting, and it returns `undefined`. `preserveUnreadableStateFile`
throws when it cannot copy the file; the caller refuses its write either way.

`listStateFileCopies(home, file?)` lists the copies newest first, as
`StateFileCopy` (`path`, `file`, `kind: 'backup' | 'corrupt'`, `at`).
`rewriteStateFileBackups(home, file, edit)` changes every copy of one file: `edit`
gets a copy's text and returns its new text or `undefined` to remove it, and a copy
the edit throws on is removed. The account registry uses it so that a removed API key
does not stay in an old copy of `accounts.json`.

`writeFileAtomicSync(file, content, { mode? })` is the write both use: a temporary
file beside the target created with `mode` (default 0600), flushed with `fsync`,
renamed over the target, and the folder flushed where the platform allows it.

Nothing is restored on its own. Restoring is copying a `.backup.` file back over the
file it copies, while no Namzu process is changing it.
