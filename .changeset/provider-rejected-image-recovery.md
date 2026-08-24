---
"@namzu/sdk": major
"@namzu/cli": patch
---

Recover a server-confirmed invalid-image request once when the provider-bound
history contains exactly one distinct image. HTTP 400 responses carrying the
exact `invalid_image` provider code preserve the original bytes with durable
`modelOmission` metadata after a successful image-free retry, suppress that
image on later requests, and emit a measured history-repair event. A legacy
phrase can recover the current request but cannot claim durable server proof;
failed, ambiguous, partial-output, and cancelled attempts leave history unchanged.

SDK consumers that exhaustively switch over
`message_history_repaired.source` must handle the new
`provider-rejected-image` member. Persistence implementations must retain the
optional `modelOmission` field on image attachments and image tool-result
blocks. `ProviderErrorInfo.providerCode` is now the bounded machine identifier
from a provider error response; do not parse `detail` for provider-defined
codes. Hosts should render the repair as retained bytes with model delivery
suppressed, not as deletion.
