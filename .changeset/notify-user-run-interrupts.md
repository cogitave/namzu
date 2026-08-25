---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Add the observational `run_interrupt` plugin hook for explicitly user-cancelled root runs. Every registered interrupt handler gets a bounded cleanup window before the durable cancellation event; one handler's skip, error, retry, or timeout no longer suppresses later interrupt observers.

Attribute interactive CLI turn interrupts to the public `user` cancellation cause so configured interrupt hooks run on both ordinary Stop actions and permission-prompt cancellation.
