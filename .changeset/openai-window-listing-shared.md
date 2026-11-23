---
'@namzu/openai': patch
---

The subscription route's model list now reads a window or an effective percentage that the backend sends as a numeric string, and callers that ask for the window while the list is loading share one request instead of each waiting out their own.
