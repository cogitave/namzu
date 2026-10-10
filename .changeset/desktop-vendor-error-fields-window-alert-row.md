---
"@namzu/desktop": patch
---

Failed replies no longer show a provider's raw JSON in Details: an Anthropic, OpenAI or Google error body is read into "Status · Provider said · Type" (with the request ID on its own line), and an unknown body becomes a short plain excerpt. The window's error alert (for example "too small to split") is now a row above the panes instead of floating over the tab strip, can always be dismissed, and offers "Try again" only when trying again can help. On the computer page the error banner takes its own row instead of covering the page. If you wrote your own checks against the old "(403 {…})" Details line or the absolutely positioned alert, update them.
