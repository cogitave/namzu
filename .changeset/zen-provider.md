---
"@namzu/zen": minor
"@namzu/cli": minor
---

Add optional Zen and Zen Go providers for OpenCode's services using Namzu's
existing model contract. Exact service/model catalogue entries select Chat Completions,
Responses, Anthropic Messages or Google streaming transport. Tool
continuations, native reasoning metadata, conversation attribution,
cancellation and classified provider errors remain part of the normal
Namzu kernel lifecycle.

The CLI exposes Zen (`zen`) and Zen Go (`zen-go`) in provider selection and
headless runs. Configure Zen with `OPENCODE_API_KEY` or
`OPENCODE_ZEN_API_KEY`, and Go with `OPENCODE_GO_API_KEY`. The actual Namzu
conversation is retained for service attribution across turns and resume.
The driver requires Node.js 20+, an explicit API key, and a known model or
an explicit protocol for an unknown model. Bundled prices are estimates;
unsupported controls and content combinations are refused.
