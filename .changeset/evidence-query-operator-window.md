---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Fix opt-in evidence query resolution skipping follow-up questions after six or
more assistant progress messages. Within the existing 64-message scan, retain
the nearest preceding operator request and five recent updates when progress
would otherwise fill all six reference slots. The prompt, retrieval and scan
ceilings remain unchanged. A missing or compacted-away request is not invented.

Do not rewind the reference window to an older identical question when the
current retained input is outside visible history, such as steering carried on
a tool result. Use the known message object as the boundary when available;
otherwise consider bounded recent history instead of inventing a position.

Normalize grounded filenames and punctuation-separated identifiers into the
same word tokens used by evidence discovery. A valid term such as
`sevkiyatlar.txt` no longer causes the entire optional plan to fail; all expanded
tokens must remain grounded and fit the existing 16-token ceiling.

Cover this behavior through the CLI Session host, including the existing
`resolveEvidenceQueries: false` opt-out. The CLI adds no default model call.
