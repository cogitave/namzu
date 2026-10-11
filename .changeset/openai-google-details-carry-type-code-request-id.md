---
"@namzu/sdk": patch
"@namzu/openai": patch
"@namzu/google": patch
"@namzu/desktop": patch
---

A failed OpenAI or Google request now reaches the host with the provider's own type, code, parameter and request ID, as an Anthropic failure already did, so Details read "Status: 403 · Provider said: “…” · Type: invalid_request_error · Code: model_not_found" with "Request ID: …" on its own line. The error's `detail` for a vendor SDK error whose message is only a sentence is now a JSON body of those fields (`{"error":{"message","type","code","param"},"request_id"}`) instead of the bare sentence; read `providerCode` or the `Details` of a host rather than matching the sentence text. The Google driver now reads its refusal body and request-ID header. The vendor project line in Details reads "Project: proj_…".
