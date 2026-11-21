---
'@namzu/cli': patch
---

Permissions > View rules (and `/permissions rules`) now lists the rules you saved with "Yes, and don't ask again" and the allows held for this conversation, each with where it lives. In plan mode, reading the session's own plan file no longer asks "Outside the working directory". A saved labelled account (for example one added with its own key and base URL) is used at start instead of the provider picker appearing with "No API key found".

Provider setup's install question (`npm install --global ...` for a missing CLI) now starts on Cancel and takes no letter as an answer: a sentence typed into that screen by mistake can no longer install anything. To install, move to Install with an arrow and press Enter; `y` no longer installs.
