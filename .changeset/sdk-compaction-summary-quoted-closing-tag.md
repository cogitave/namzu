---
"@namzu/sdk": patch
---

A model-written compaction summary that quotes its own closing `</summary>` tag in its text - which happens when the earlier conversation it summarises showed that markup, in a tool result or a file - is now read whole. The summary is taken from its opening tag to the closing tag that ends the reply, so the quoted tag no longer cuts it short and the session no longer resumes from half a summary; the reasoning block before the summary is stripped to its last closing tag for the same reason, and a reply cut off before its closing tag still reads from its opening tag.
