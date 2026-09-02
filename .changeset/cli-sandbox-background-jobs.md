---
"@namzu/cli": minor
---

Background jobs work under the sandbox: `run_in_background` starts the job inside the same bwrap or seatbelt boundary the foreground command would run in, `/jobs` lists it, and it is stopped with the session. A sandbox tier that cannot start a detached process still has none, and the model is told which case it is in.
