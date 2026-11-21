---
"@namzu/cli": patch
---

Fixes in the terminal screen. An Edit or Write result shown on the scroll-back screens keeps its indentation and added/removed colours instead of ending every line with "..". A file inside the project is named relative to it in a tool call's header, and a long path is cut in the middle so the file name stays. A pasted block you send stays as its chip (`[Pasted text #1 +40 lines]`) in the conversation; the model still receives the full text. `/compact` counts tool calls and results when it reports how much smaller the conversation got. The shells list and the workflow view no longer blank the conversation above them, and a field in an agent row is dropped whole instead of showing a bare "…".
