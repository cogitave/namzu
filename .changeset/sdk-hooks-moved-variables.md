---
'@namzu/sdk': minor
---

A hook command written for another tool now finds the project folder. When a shell hook's `command` or `args` refer to a variable (`$NAME` or `${NAME}`) that is not set and whose name ends in `_PROJECT_DIR`, the command is started with that variable set to the project folder, the value of `NAMZU_PROJECT_DIR`. A variable that is already set is never overwritten, and an entry that refers to no such variable starts with exactly the environment it had.

A command entry (`ShellHookEntry`) also takes `env`, a map of names to text, for a script that reads such a variable inside its own file. A value may use `$NAME` or `${NAME}` of a variable the hook already has, such as `${NAMZU_PROJECT_DIR}`. The variables Namzu sets for every hook cannot be replaced. When a hook cannot find its program and its command refers to a variable that is set nowhere, its failure reason (and the warning in the log) names the variable and the `env` key. New exports: `shellHookEnvProblems`, `shellHookEnvNameProblem`, `referencedVariables`, `MOVED_FOLDER_ENDINGS`, `SHELL_HOOK_RESERVED_ENV`, and `ShellHookOutcome.unsetVariables`. Nothing existing changes and nothing has to be done to upgrade; if you pass your own environment variable ending in `_PROJECT_DIR` through a hook, it is still never replaced.
