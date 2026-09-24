---
'@namzu/sdk': minor
'@namzu/cli': patch
---

A scheduled run may now run a command whose code merely mentions namzu. `powershell.exe -NoProfile -Command "[System.Windows.MessageBox]::Show('Namzu: scheduled job running','Namzu')"` was refused by the scheduled-run floor, because text passed to PowerShell, `cmd`, Python, Node or a shell reading its input was refused whenever it contained `namzu` or `schedul`. Such text is now refused only when it holds something that can reach the scheduler or `NAMZU_HOME`: a `schedule` subcommand other than `list`, `show`, `status`, `history` or `logs` with the CLI or an expansion in reach, the service's name (`namzu-scheduler…`, `com.namzu.…`), a service tool with a namzu name or a `*`, `pkill`/`killall`, `NAMZU_HOME` by name, `.namzu` as a path segment, a path into either protected folder, or `LOCALAPPDATA` with a `namzu` segment. A job that was refused for naming the product runs; nothing that reached the scheduler before is let through (checked against bash on 35 159 generated lines, and on 1 189 labelled lines of PowerShell, `cmd`, Python, Node and `sh` code).

The refusal now says which rule matched and where (``the argument `~/.namzu/x` names NAMZU_HOME (/home/you/.namzu)``, ``… it holds `schedule stop` (a `namzu schedule` subcommand other than …), in the argument `namzu schedule stop` ``) instead of listing everything the floor protects.

SDK: a `predicate` authorization rule may carry `describe(call)`, asked after `decide` returned a decision; its answer is the gate's reason for that call instead of the rule's fixed `description` (a `null`, empty or thrown answer keeps `description`). `describeRule(rule, call?)` takes the call as an optional second argument. Both are additions; existing rules and callers are unchanged.
