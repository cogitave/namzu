---
'@namzu/cli': minor
---

Add `/copy`, which sends the latest available raw assistant output to the terminal clipboard through a bounded OSC 52 request.

While another turn is streaming, the previous normally completed answer remains the target. Partial or abnormal completions do not replace it, `/clear` and `/compact` preserve it, and `/resume` selects the newest persisted assistant output in the resumed conversation.

The command refuses non-interactive terminals and output above 100,000 UTF-8 bytes without truncating. Because OSC 52 cannot acknowledge clipboard acceptance, the UI reports that a request was sent and warns that terminal policy may ignore it instead of claiming the clipboard changed.
