---
"@namzu/openai": patch
"@namzu/cli": patch
---

Preserve Codex native response items when the subscription stream sends them as completed output-item events but leaves the final response output empty. Newly recorded conversations now retain those reasoning and tool-call items for eligible tool continuations and resume. The same correction retains hosted citations and reports tool-call finish reasons correctly. Existing route and message-integrity checks remain in force; native state already discarded by older versions cannot be recovered by upgrading.
