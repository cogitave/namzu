# @namzu/google

## 0.3.0

### Minor Changes

- 64d9b9b: CLI auto search now selects native live search for supported direct Anthropic and Google API-key models instead of Exa. Native requests use provider quotas and execute without local tool approval. Set `web.backend: exa` to keep the previous common-search behavior on these routes. Unsupported model/endpoint combinations retain common search under auto; cached mode is never silently changed to live.

  Add model/mode-aware hosted-search capability checks, preserve them through provider wrappers, and forward hosted search through ReactiveAgent and delegated runs. Anthropic retains encrypted search blocks and citation indices for unchanged matching-route continuation; Google retains grounding source links. Common search previews omit internal provenance framing while preserving raw results for the model and history.

## 0.2.0

### Minor Changes

- 7785cb4: Add Google model access with a native SDK provider and CLI model selection. Reuse an existing Gemini CLI Google sign-in from this device, including the paired Windows home under WSL, without requiring a new API key. Explicit Gemini or Google API keys remain an alternative and take precedence when configured. Borrowed sign-ins are refreshed in memory without rewriting their owner file; Google account access retains the Code Assist route rather than being sent to the API-key endpoint.

Initial native Gemini API and existing Gemini CLI OAuth transport.
