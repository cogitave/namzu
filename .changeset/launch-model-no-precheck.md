---
'@namzu/cli': patch
---

`namzu --model <id>` no longer checks the id against the provider's model list when it starts. That check warned "has no model called …" for a model the provider does serve whenever the id carried a `[1m]` window marker, and it would equally misfire for an endpoint whose list is incomplete or names models differently. The id is now sent as given (without its marker), and a model the provider really does not know is explained when its reply fails, with a pointer to `/model`. Nothing to change on your side.
