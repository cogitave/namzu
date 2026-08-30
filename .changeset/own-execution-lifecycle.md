---
'@namzu/sdk': patch
---

Make execution-context lifecycle transitions single-owner and truthful. Concurrent initialization or teardown calls now share their active operation, teardown prevents a late initialization from restoring readiness, and cleanup failures emit an error without also announcing successful teardown. Hybrid contexts start local and remote cleanup together and surface child cleanup failures instead of silently discarding them.
