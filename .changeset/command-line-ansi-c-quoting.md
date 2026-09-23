---
"@namzu/sdk": patch
---

A command line with an ANSI-C quote (`$'…'`) is no longer approved by an `allow` rule or a skill's `Bash(<pattern>)` entry. It now goes to review like any other call no rule covers.

Inside `$'…'`, `\'` is an escaped quote. The command-line reader took `$'\''` for a closed quote followed by an opening one, so it read the rest of the line as quoted text while bash ran it. An `argument_pattern` allow rule for `^git status`, or a skill granting `Bash(git status *)`, therefore approved `git status $'\'' ; touch pwned #'` and `git status $'\'' > ~/.bashrc #'` without asking. The reader now handles the quote's escapes, so a `deny` rule sees the commands that come after it. Because the escapes are decoded only when bash runs the line, a line containing one is also treated as opaque, the same as a command substitution. A host whose allow rules used to approve such lines will now see a prompt for them. No configuration change is needed.
