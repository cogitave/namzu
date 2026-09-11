---
"@namzu/cli": major
"@namzu/sdk": minor
"@namzu/anthropic": minor
"@namzu/google": minor
---

CLI auto search now selects native live search for supported direct Anthropic and Google API-key models instead of Exa. Native requests use provider quotas and execute without local tool approval. Set `web.backend: exa` to keep the previous common-search behavior on these routes. Unsupported model/endpoint combinations retain common search under auto; cached mode is never silently changed to live.

Add model/mode-aware hosted-search capability checks, preserve them through provider wrappers, and forward hosted search through ReactiveAgent and delegated runs. Anthropic retains encrypted search blocks and citation indices for unchanged matching-route continuation; Google retains grounding source links. Common search previews omit internal provenance framing while preserving raw results for the model and history.
