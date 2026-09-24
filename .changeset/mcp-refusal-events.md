---
"@namzu/sdk": minor
---

`MCPToolDiscoveryOptions` and `MCPToolsetOptions` gain `onRefused`. The callback reports the current policy refusals for each tool, prompt and resource listing, including an empty list when a later listing clears them. Hosts can show which server names were excluded and why.
