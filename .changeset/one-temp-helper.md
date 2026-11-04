---
"@namzu/sdk": minor
"@namzu/cli": minor
"@namzu/sandbox": patch
---

Namzu's temporary files now live in one place you can move. Set `NAMZU_TMPDIR` to a full path to put them on another disk; unset, nothing moves from the operating system's temporary folder (`TMPDIR`, `TMP`, `TEMP`). Under it Namzu keeps a private `namzu-<user>` folder (mode 0700, refused when it is a symbolic link, belongs to someone else or is open to other users) and puts there what used to land loose in the shared temporary folder: the shell's working-directory marker (`namzu-cwd-*`), rendered PDF pages, the sandbox's own working directory, pasted clipboard images, the external editor's draft, the update download, the `namzu doctor` code-analysis probe and a local Pal computer's port-forward files. A pasted image or draft is therefore no longer a world-readable path under `/tmp`.

New SDK exports for hosts that want the same behaviour: `NAMZU_TMPDIR_ENV`, `resolveTempBase`, `privateTempRoot`, `createTempDir`, `createTempDirSync`, `tempFilePath`, `TempDirectoryError`. `tempRoot` now honours `NAMZU_TMPDIR` too and still throws `SessionPathError` for a refused folder.

What changes when something is wrong: there is no silent fallback to another folder. A folder that cannot be created on a full disk stops with one line that names it and the variable ("The disk is full, so Namzu could not create <folder>. Free some space and start again, or set NAMZU_TMPDIR to a folder on another disk.") and, at start-up, exits with status 69 instead of a stack trace; a used-up quota, an unwritable or missing folder and a relative `NAMZU_TMPDIR` get their own plain sentences. A full disk under `NAMZU_HOME` is reported the same way, naming `NAMZU_HOME`. `namzu doctor` now checks the chosen base and the private folder.

Unchanged on purpose: the peer-socket runtime directory still falls back to the operating system's folder (a long `NAMZU_TMPDIR` can exceed the socket-path limit), and the macOS computer-use screenshot file and the code-analysis host's working directory still use the operating system's folder. To keep every file where it was, leave `NAMZU_TMPDIR` unset.
