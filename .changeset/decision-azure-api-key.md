---
'@namzu/cli': minor
---

The Azure decision provider can use an API key: set `apiKeyEnv` in the `decision` block to the environment variable that holds it, and it is sent as `api-key` (read at each call). It cannot be combined with `tokenEnv`, and a resource with local authentication disabled still needs the token. The choice and score questions of the `decide` tool, until now unconfirmed, now use the service's real request and answer shapes, and a score answer carries the probability-weighted `score` and a `confidence`.
