---
'@namzu/openrouter': patch
---

An OpenRouter failure now says which upstream host refused the request and its code (for example `host AcmeCloud, code bad_param`), on an HTTP error and on an error that arrives mid-stream, so a person can tell a host's refusal from the router's. The host's raw echo of the request is still never shown. Cache writes are now counted for models with explicit caching (`prompt_tokens_details.cache_write_tokens`, used when the older field is absent; the prompt size is unchanged). A thinking budget is no longer sent at or above the request's output limit: with an output limit above 1024 it is brought under it, and a budget under 1024 is raised to 1024; effort-mode requests are untouched.
