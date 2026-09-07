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
headless runs. Zen supports anonymous public models and optional credentials;
Go requires its own key. The actual Namzu
conversation is retained for service attribution across turns and resume.
The driver requires Node.js 20+ and a supported public model, or a real key
with a known model or explicit protocol. Bundled prices are estimates;
unsupported controls and content combinations are refused.
