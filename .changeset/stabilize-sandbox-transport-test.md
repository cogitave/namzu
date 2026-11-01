---
"@namzu/sandbox": patch
---

No runtime behavior changes. Stabilize the Kubernetes transport regression test by reserving its unused TCP port throughout the test, preventing unrelated parallel listeners from taking that port and producing a false failure in release validation.
