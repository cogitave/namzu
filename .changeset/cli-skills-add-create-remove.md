---
'@namzu/cli': minor
---

New commands `namzu skills add`, `namzu skills create` and `namzu skills remove`. `add` puts skills from a `.zip`, `.skill`, `.md` or folder (up to 20 inputs, 30 MB each) into `~/.namzu/skills`, or `./.namzu/skills` with `--scope project` in a trusted folder. A skill that declares hooks, pre-approves a shell tool, holds inline shell commands or ships scripts is shown to you first and needs a yes (`--yes`, or exit 75 when nobody can be asked). A replaced or removed skill is moved to `~/.namzu/backups/skills/`, never deleted. Nothing changes for existing commands; the unknown-command message for `namzu skills` now lists the new ones.
