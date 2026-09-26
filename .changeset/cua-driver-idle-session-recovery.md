---
"@namzu/computer-use": major
---

The Windows cua-driver backend now revives an implicit session after its five-minute idle expiry and retries a call that the driver explicitly refused before dispatch. UI Automation snapshots now return adapter-owned refs instead of raw cua-driver element tokens. Callers passing raw tokens to `uiAct` must use refs from the latest `uiSnapshot`; old refs cannot address a different control when the driver reuses a token after session revival or process restart. Calls whose outcomes are unknown are still not retried automatically.
