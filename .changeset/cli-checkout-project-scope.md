---
"@namzu/cli": major
---

New working directories inside a Git checkout now share the checkout-root Project,
conversation list and searchable memory. Previously every exact working directory
created a separate Project. Existing directory bindings retain their IDs, Topics
and histories; worktrees, nested repositories and standalone directories remain
separate. Existing records are not merged or moved. Use a separate checkout or
application home when new work needs separate history.

New project memory files created from a repository subdirectory now live at the
checkout root. An existing directory-local `.namzu/MEMORY.md` still takes precedence,
including an empty file. Create that local file before writing notes to retain
directory-specific memory.

Concurrent first launches now use one installation identity and one Topic per
Project. Malformed existing identity or Topic metadata causes an error instead
of being silently overwritten. Preserve or repair that metadata before retrying;
replacing an identity changes which tenant's history the CLI can access.
