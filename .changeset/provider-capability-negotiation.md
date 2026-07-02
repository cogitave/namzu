---
'@namzu/sdk': minor
---

Provider capability negotiation — degradation is now loud, not silent.

`LLMProvider` gains an optional `readonly capabilities?:
ProviderCapabilities` (with a new `supportsVision?` flag on the type)
declaring what the DRIVER actually does with a request. Providers that
declare nothing resolve to the exported
`PERMISSIVE_PROVIDER_CAPABILITIES` constant (assume everything works —
exactly the previous behavior), so third-party providers are
unaffected. `resolveProviderCapabilities(provider)` performs the
per-field permissive merge.

`query()` consults the resolved capabilities before tooling bootstrap:

- Tools registered against a `supportsTools: false` driver → a loud
  `log.warn`, a new `capability_warning` run event, and every tool
  surface stripped (no `<available_tools>` prompt section, no `tools`
  request param) so the model is never told about tools it cannot
  call.
- Image attachments on user messages against a `supportsVision: false`
  driver → `log.warn` + a `capability_warning` run event so the host
  can surface that the images never reach the model.
- New `QueryParams.strictCapabilities?: boolean` (default `false`)
  throws on either mismatch instead of degrading.

`RunEvent` gains the additive `capability_warning` variant
(`capability: 'tools' | 'vision'`, `providerId`, `message`); the
SSE/A2A bridges intentionally do not map it to a wire event yet.
