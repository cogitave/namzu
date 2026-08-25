---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Let task schedulers preserve an optional structured cancellation cause, and
make the blocking `Agent` delegation end with the run that launched it. Parent
cancellation now reaches both already-running tasks and tasks whose creation
finishes late; built-in local and foreign schedulers expose `parent` on the
child signal.

Make the interactive session own its subagent runtime so Stop, session
replacement and shutdown prevent late child tool work after the parent has
settled.
