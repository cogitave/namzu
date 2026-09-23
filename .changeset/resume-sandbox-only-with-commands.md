---
'@namzu/cli': patch
---

A parked scheduled run whose job cannot run shell commands (`bash` denied, as in the `read-only` preset) can be continued from a TUI session whatever its sandbox setting. It used to be refused unless the session's sandbox matched the job's `execution`, which for a browser job created with `execution: sandbox` meant editing your config to continue it. A job that can run commands is still continued only from a matching session. The refusal now says a run a page parked "is waiting for you" rather than "waiting for approval".
