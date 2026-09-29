---
'@namzu/sandbox': patch
---

Sandbox unit tests now limit worker parallelism on many-core hosts. Kubernetes transport tests also use a stable unreachable address for an unchanged pod and accept an acquire deadline that expires during the initial API request before readiness polling starts. Published runtime behavior is unchanged.
