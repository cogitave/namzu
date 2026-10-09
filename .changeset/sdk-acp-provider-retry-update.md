---
"@namzu/sdk": minor
---

The ACP bridge now sends a `provider_retry` session update when a model call fails
transiently and will be tried again: `attempt`, `maxRetries`, `delayMs`, an optional
HTTP `status`, `serverDirected` and the `turnId`. It carries no provider body, header
or credential. A client can show "waiting, retrying in 6 seconds" instead of a silent
spinner.

`AcpSessionUpdate` gains this member. A client that already ignores update kinds it
does not know needs no change; a client with an exhaustive `switch` over
`update.kind` should add a `provider_retry` case (or a default branch) before it
upgrades the type.
