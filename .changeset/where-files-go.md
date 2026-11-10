---
'@namzu/cli': major
'@namzu/sdk': minor
---

A session now tells the model where to put what it creates (temporary work in the scratchpad, app data and config in the platform's standard folders, containers in a named project folder, a checklist for anything that keeps running) and ends a setup with a short receipt. The terminal UI shows one quiet line at start when the working folder is your home folder or the filesystem root.

**Breaking for unattended runs:** bypass mode now asks before a call creates or deletes a top-level entry directly in your home folder or the filesystem root (`mkdir ~/newthing`, `git clone <url> ~/repo`, `rm -rf ~/thing`, a file tool creating `~/new.txt`), like it already does for protected files; where nobody can be asked (`exec`, a scheduled run) the call is refused with a message that says why. If you want such a folder, create it yourself (for example with `!mkdir` in the composer) or answer yes when asked; a rule cannot allow it. Anything inside an existing folder, and changes to a top-level entry that already exists, are not asked about. In the SDK, a query that sets `outsideRootAccess: 'review'` (and runs without a sandbox) reports these paths in `escalation.protectedPaths`; queries that do not set it are unchanged.
