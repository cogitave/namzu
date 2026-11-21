---
'@namzu/cli': patch
---

Fix the Claude sign-in failing with "Authorization failed / Invalid request format": the sign-in address now asks for the scopes the sign-in page registers (adding `user:plugins` and `user:privacy_consents:write`) and sends a 32-byte state.
