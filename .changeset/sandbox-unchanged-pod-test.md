---
'@namzu/sandbox': patch
---

The Kubernetes transport test for an unchanged pod now uses a stable unreachable address instead of a just-closed ephemeral loopback port that another process could claim. Published runtime behavior is unchanged.
