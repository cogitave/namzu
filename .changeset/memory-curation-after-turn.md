---
'@namzu/cli': patch
---

Memory curation no longer starts while a turn is streaming or a tool is running, so it cannot compete with the reply (a model call already out when the turn starts is not stopped; it finishes by itself, and nothing new starts). A turn that ends by a cancel or an error now releases what waited, like one that completes. What waited drains after the turn settles and a short pause; closing the session still drains once. Nothing to change on your side.
