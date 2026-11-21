---
'@namzu/sdk': minor
---

New exports for small files that more than one process changes: `withFileLock`, `withFileLockSync`, `lockPathFor` and `FileLockError` (the lock-file protocol the account locks already used, now under a general name), and `backupStateFile`, `preserveUnreadableStateFile`, `listStateFileCopies`, `rewriteStateFileBackups`, `stateBackupsDir`, `writeFileAtomicSync` with `STATE_BACKUPS_DIR`, `STATE_BACKUP_KEEP` (5) and `STATE_BACKUP_MIN_INTERVAL_MS` (60 s). `AccountLockError` is now a subclass of `FileLockError`; its `name` is still `AccountLockError`, and `AccountLockOptions` / `AccountLockSyncOptions` are the same shapes as before.

The account registry now copies `accounts.json` to `<home>/backups/accounts.json.backup.<epoch ms>` (mode 0600, at most one a minute, five kept) before each change, and removing an API-key account also takes that key out of every copy. Nothing to change on your side; delete `<home>/backups/` if you do not want the copies.
