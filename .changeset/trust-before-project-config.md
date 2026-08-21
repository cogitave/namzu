---
'@namzu/cli': patch
---

Keep untrusted project authority out of CLI startup.

Interactive and headless launches now resolve only user, environment and
managed configuration before the folder trust decision. Project config,
project commands and project instructions activate together after trust, using
the actual `--cwd` target for headless runs. Invalid project config can no
longer outrun an untrusted-folder refusal, and the canonical approved directory
is pinned so a later symlink swap cannot redirect the launch. Headless sessions
also now receive their configured sandbox policy instead of silently dropping
it.
