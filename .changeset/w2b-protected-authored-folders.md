---
'@namzu/sdk': major
---

`isProtectedPath` no longer reports paths under `.namzu/skills`, `.namzu/agents`, `.namzu/commands` and `.namzu/worktrees`, so writing a skill, an agent definition or a command no longer raises a protected-path question each time. Everything else under `.namzu` (settings, memory, hooks) is still protected, and so is any `.git` or second `.namzu` below those folders. New export `PROJECT_DIRECTORY_AUTHORED_FOLDERS` lists the four names. To keep asking, check the path yourself before calling.

This changes the default protected-path result for the four project-authored folders from protected to unprotected. Hosts that require the previous question must retain an explicit protected-path policy for those folders.
