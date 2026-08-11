---
'@namzu/cli': major
---

A config file that cannot be read stops the run instead of being read as an empty one

**What breaks.** `loadConfig` returned `{}` for a config file it failed to open
or parse, which is the same answer it gives for a file that is not there. It now
throws `ConfigLoadError`, and the binary exits `78` (sysexits `EX_CONFIG`) with a
message naming the file. Three inputs that used to start a run now refuse:
a file that exists and cannot be opened, a file whose contents do not parse, and
a file whose top level is not a mapping of settings.

**Why this is not a nicety.** `permissions` is read from these files. An empty
config is an empty rule table, and a headless run resolves every call no rule
covered to `auto` — so a `deny` an operator had written became approval of
exactly those calls, with nothing printed to say the table had been dropped. The
fail-open landed on the one path where nobody is watching, and a missing brace
was enough to reach it.

**What a caller does about it.** If the run should have no rules, delete the file
or empty it — absent and empty both still mean "no settings", and neither throws.
If the file is meant to be read, the message names the file and the reason; fix
it. A host embedding the CLI that wants the old behaviour has to catch
`ConfigLoadError` itself and decide, in the open, that starting unrestricted is
what it wants.

Also new: `EXIT_BAD_CONFIG` (78) is exported alongside the other exit codes, and
`ConfigLoadError` is exported from the package root.
