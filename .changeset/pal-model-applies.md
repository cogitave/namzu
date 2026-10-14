---
"@namzu/cli": patch
---

A Pal's conversation now uses the Pal's current model. Before, the model the Pal had when its conversation opened was kept for good, so changing the Pal's model afterwards (or setting it after the page filled in a default) never reached the conversation. Nothing to change on your side; a model picked by hand in the Pal's composer is still kept for that conversation.
