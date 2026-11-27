---
type: Reference
title: namzu skills add, create and remove
description: Add skills from files or folders, write one from flags, and remove one, with the checks, the consent shown before a skill that can run commands, backups, the provenance file, the JSON shapes and the exit statuses.
resource: packages/cli/src/skills/add.ts
tags: [cli, skills]
status: stable
generated: { by: process:claude-code, at: 2026-11-27T00:00:00Z }
---

# namzu skills add, create and remove

Three commands change your skills without a conversation. They use the same
rules as the `save_skill` screen in the terminal ([Skills](skills.md#making-a-skill)):
one validator for the name, the description and the instructions, one writer for
the folder.

```
namzu skills add <file.zip|file.skill|file.md|folder>... [--scope user|project] [--name <skill>] [--replace] [--yes] [--json]
namzu skills create <name> --description <text> (--instructions <text> | --instructions-file <path|->) [--scope user|project] [--replace] [--json]
namzu skills remove <name> [--scope user|project] [--yes] [--json]
```

`--cwd <dir>` names the folder whose project skills are meant (default: the
current one). `--scope user` (the default) is `~/.namzu/skills`
(`$NAMZU_HOME/skills`); `--scope project` is `<cwd>/.namzu/skills` and works only
in a folder you have trusted (exit 77 otherwise, with how to trust it). A user
skill is allowed from an untrusted folder, and then that folder's own skills are
not read.

## What `add` accepts

Up to 20 inputs per call, each independent: one that fails does not stop the
others. A file over 30 MB is refused (`Skill file is too large. Maximum size is 30
MB.`). The inputs:

| Input | How it is read |
| --- | --- |
| `.md` | Wrapped as `SKILL.md`. It must hold YAML frontmatter with a `description` (`A .md file must contain the skill name and description formatted in YAML.`). The name is the frontmatter `name`, else the file name when that is a valid name. |
| `.zip`, `.skill` | A zip. It needs one `SKILL.md` (any letter case, written as `SKILL.md`) at its top or inside one wrapping folder. `__MACOSX` and `.DS_Store` are ignored; files outside the wrapping folder are left out and counted. |
| a folder | `SKILL.md` at its top; the rest of the folder comes with it. `.git`, `node_modules` and `.DS_Store` are skipped. A link anywhere inside refuses the folder. |

More than one `SKILL.md` is a bundle and is refused: `This file holds N skills. Add
them one at a time, or install it as a plugin.`

The name is `^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 64 characters, from the
frontmatter, else the wrapping folder, else the file or folder name. A name that
does not fit is refused with the one that would (`Weekly Status.md` without a
frontmatter name gets `Try "weekly-status" (add --name weekly-status)`). `--name`
sets the name for a single input and rewrites the `name:` line. The description is
required, at most 1024 characters, with no `<tag>` text; the instructions are not
empty and at most 64 KiB. Frontmatter keys Namzu does not read are kept and
listed. A name that is a built-in skill's is refused (`"x" is the name of a
built-in skill, so it cannot be used.`).

### Zip safety

A zip goes through the shared archive reader with skill limits: at most 500
entries, 64 MiB unpacked, a ratio of 100 to 1. An absolute path, `..`, a
backslash, a control character, a duplicate (or two names that differ only by
letter case), a link or device entry, or an encrypted entry refuses the whole
file and nothing is written. Execute bits are kept only on files under
`scripts/`; elsewhere the bit is dropped and the result says so. No setuid or
setgid bit is ever written.

## What it asks first

A skill with nothing that runs installs without a question: you chose the file.
A skill that declares hooks, pre-approves a shell tool in `allowed-tools`, holds
inline shell commands (`` !`cmd` ``) or ships files under `scripts/` is previewed:

```
Runs commands: git status
Pre-approves while this skill runs: Bash(git log:*)
Ships scripts: scripts/run.sh
```

and needs a yes: at a terminal a `[y/N]` question on standard error, otherwise
`--yes`. With no terminal and no `--yes` nothing is written and the exit status is
75. The staged copy is also read by the same loader the model uses, so a skill
that would not load is refused before anything is installed, and what the audit
says about its hooks is listed.

A skill of the same name in the target folder needs `--replace` or a yes (`--yes`
or the terminal question). Skills of that name in other tiers are reported
(`replaces user skill …`, `hidden by project skill …, which keeps winning`).

## How it is written

1. The files are written to `<skills folder>/.staging/<id>/<name>/`, which the
   skill reader never lists, together with `.namzu-install.json`.
2. A replaced folder is moved to `$NAMZU_HOME/backups/skills/<name>.<ms>/`.
3. The staged folder is renamed into place.

A failure after step 2 puts the old folder back; if that fails too the backup
stays and the message names it. There is never a skill with some old files and
some new ones, and no step follows a link: a skills folder, a `.namzu` folder or a
skill folder that is a link refuses the write.

`.namzu-install.json` holds `version`, `source` (`file`, `folder` or `create`),
`fileName`, `sha256`, `installedAt`, `findings` and the list of `files`. The skill
reader ignores it. `remove` reads it to say where a skill came from and how many
files were added to it later.

On success: `Added skill "weekly-report" to your skills (3 files). It is available
from your next message.` (`Replaced skill …` with the backup path when it
replaced one; `this project's skills` for the project folder).

## `create`

The same validators and writer, from flags, with no model. `--instructions-file -`
reads standard input (at most 1 MB). Instructions that start with a `---` block
are refused (`Your instructions start with a --- block. Remove it: the name and
description become the frontmatter.`). The file is written the way `save_skill`
writes one, with `namzu-origin: created`. Instructions that hold inline shell
commands get the same `Runs commands: …` preview and need `--yes` (exit 75
without one), as with `add`: typed text is not exempt.

## `remove`

Only a skill in your user or project folder. A plugin's skill is refused (`This
skill comes with plugin "x". Turn the plugin off or uninstall it.`), so is a
built-in one, one in a shared `.agents/skills` folder, and one whose folder is a
link. Without `--yes` it asks (`[y/N]` at a terminal, exit 75 without one), then
moves the folder to `backups/skills/` and says where: `Removed. A copy is in
~/.namzu/backups/skills/x.<ms>/ if you want it back.` When the name is in both
the user and the project folder, `--scope` says which. If `backups` (or any
folder above `backups/skills`) is a link, nothing is moved and the command fails,
so a copy can never land outside the Namzu home.

## `--json` and exit statuses

`--json` prints one object on standard output; questions and notes go to standard
error.

```json
{
  "version": 1, "ok": true, "exitCode": 0, "added": 1,
  "results": [{
    "input": "weekly-report.zip", "status": "added", "message": "Added skill …",
    "name": "weekly-report", "scope": "user", "path": "/home/you/.namzu/skills/weekly-report/SKILL.md",
    "files": 3, "findings": [], "notes": []
  }]
}
```

`status` is `added`, `replaced`, `failed`, `refused` (unsafe input),
`needs-consent` (with `preview`) or `declined`. `create` has the same shape;
`remove` prints `{ version, ok, exitCode, status, name, scope, path, backup,
message, details }` with `status` one of `removed`, `not-found`, `usage`,
`unsafe`, `refused`, `needs-consent`, `declined`, `failed`.

| Exit | Meaning |
| --- | --- |
| 0 | everything was done |
| 1 | something failed; each input is named |
| 64 | the command line is wrong (including a retired spelling such as `skills install`) |
| 65 | every input was refused as unsafe, or `remove` met a linked folder |
| 66 | `remove` found no such skill, or `create` could not read its instructions file |
| 75 | a yes is needed and nobody can be asked: run it again with `--yes` (or `--replace`) |
| 77 | `--scope project` in a folder that is not trusted |
