---
'@namzu/sdk': major
---

Custom `ToolRegistryContract` implementations must add `prepareExecution` and
`executePrepared`. Decode and transform an input once, detach an immutable JSON
projection for authorization and review, retain a separate equivalent value,
and execute that preparation without parsing again. Tool schema transforms must
now return JSON-value graphs; mutable exotic values are refused. Durable tool
reviews also persist the prepared projection and authorization verdict so a
resumed approval cannot execute a changed or previously denied call.
