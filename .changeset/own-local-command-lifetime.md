---
'@namzu/sdk': patch
---

Make local command deadlines and context teardown own the spawned process group until inherited output streams close. Descendants no longer keep timed-out commands or torn-down execution contexts alive after their direct parent exits.
