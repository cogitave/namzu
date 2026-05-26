---
'@namzu/sdk': patch
'@namzu/sandbox': patch
---

Harden file intake and ACI readiness failure handling.

The built-in read tool now guides Office and PDF packages through
extractor tooling instead of treating binary document containers as
UTF-8 text. The ACI Standby Pool backend now deletes a claimed
container group when IP or worker readiness polling fails before a
Sandbox handle is returned.
