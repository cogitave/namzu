---
"@namzu/sdk": patch
---

The auto-review classifier now builds its system message once per review and sends the same message on both passes. It used to rebuild it per pass, so the two passes carried different message timestamps whenever they ran in different milliseconds. Nothing to do to take this.
