---
'@namzu/cli': major
---

A `[permissions]` rule about `bash` decides the commands the line runs

An operator's table compiled to a pattern matched against the serialised tool
input, and two loosenesses came with that subject. The rule could match the
start of any argument's value rather than the one they meant, and the match
stayed open on the right — so `bash = { "git status*" = "allow" }` also approved
`git status && rm -rf ~` and `git statusx; cat /etc/shadow`. The
dangerous-pattern floor does not cover either: it is four patterns about
catastrophic commands and says nothing about reading a credential file.

A tool that declares which of its arguments holds a command line — `bash` does —
is now compiled through the kernel's `argument_pattern`, whose subject is that
argument's own value read as the commands it runs. Chain operators, subshell
grouping and a nested `sh -c` payload are read; quoting is respected.

The asymmetry the compiler already had is carried over, because the reasons for
it did not change:

- An `allow` anchors, and now anchors **per command**: every command on the line
  must match, or the call falls through to being asked.
- A `deny` stays loose, and now also sees a command riding behind a separator:
  `"git push*": "deny"` refuses `true; git push`, and `"rm -rf*": "deny"` still
  refuses `sudo rm -rf /`.

**What breaks.** A table that relied on either looseness stops approving what it
used to. `"git status*": "allow"` no longer covers `git status && anything`;
`"*git status*": "allow"` still loosens the match within one command and no
longer reaches across commands. To approve every call to a tool, write
`"*": "allow"`, which now compiles to a by-name rule rather than to a pattern —
"every call" cannot be expressed as a pattern about an argument that a call
might not carry.

Tools that declare no command argument — MCP servers, host tools, `edit`,
`read` — compile exactly as before.
