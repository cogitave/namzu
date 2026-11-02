---
"@namzu/computer-use": patch
---

The agent cursor and presence border now also appear on a window that was opened after the overlay helper started (before, such a window got neither), they are placed correctly on displays scaled above 100%, and a helper that ends mid-session is started again by the next action instead of leaving the overlay off for the rest of the session. Nothing to change on your side.
