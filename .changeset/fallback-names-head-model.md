---
"@namzu/sdk": patch
---

The `fromModel` of a `provider_fallback` event is now set when the head of a provider chain was declared without a model: it is the model the request asked for, where before the field was missing and a host could not say which model had failed.
