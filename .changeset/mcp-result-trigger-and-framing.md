---
'@namzu/cli': patch
---

An MCP result whose text is 30,000 characters or fewer is no longer rewrapped and stripped of its structured and rich fields just because its text is over about 5,000 characters; only a result over 30,000 characters, or whose structured fields are too large, is bounded. An oversized result's text is no longer framed as untrusted a second time, and a line before it says when structured data and rich content were omitted.
