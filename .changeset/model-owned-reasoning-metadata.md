---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add optional `ModelInfo.reasoningEffortLevels` and `reasoningEffortDefault`
metadata. The CLI discovers missing model menus through provider catalogues,
retains established model-specific driver capabilities without extra network
requests, and intersects usable fallback routes. Third-party drivers can publish effort capabilities without adding
provider or model cases to the CLI. Unknown menus remain unavailable; absent
defaults do not erase known choices.
