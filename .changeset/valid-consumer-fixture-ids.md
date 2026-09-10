---
'@namzu/sdk': patch
---

Export deterministic UUID entity fixtures from `@namzu/sdk/testing` so
consumer test suites can migrate away from removed prefixed IDs without
copying the SDK's identity rules.
