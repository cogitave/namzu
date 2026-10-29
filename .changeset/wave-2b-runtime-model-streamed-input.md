---
"@namzu/cli": minor
---

Add explicit headless input/output format flags. `exec --input-format stream-json --output-format stream-json` reads native JSON user messages one line at a time and answers before stdin EOF, carrying settled history through the same session. `--input-format text` accepts text prompts with streaming output; `--output-format text|json` selects the final-result formatter. Existing `--json` and optional JSON Message[] stdin history retain their defaults.

Tell the model its exact requested runtime model/provider through recorded context rather than the cached system prompt, preserving Namzu's identity. Catalogue metadata does not establish a knowledge cutoff, so no cutoff date is invented.
