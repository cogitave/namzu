---
"@namzu/sandbox": patch
---

Qualify streamed-read resource cleanup through actual guest close events and descriptor identities. An unrelated descriptor closing cannot mask a leaked file or socket; runtime behavior and public APIs are unchanged.
