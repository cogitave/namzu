---
'@namzu/cli': patch
---

Repeated headless run invocations no longer retain stdin listeners when an open pipe sends no data. The terminal test harness also releases its process-exit hook after teardown.
