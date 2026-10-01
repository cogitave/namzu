---
"@namzu/cli": minor
---

Add the `namzu/providers/models` desktop ACP extension for reading a configured provider's model catalogue on demand. Results contain model IDs, labels, optional notes and an explicit fallback notice when listing fails or is unsupported. The extension reuses the terminal picker's access filter, keeps permitted default and session-specific choices, and never returns provider credential envelopes or raw driver error text. Existing exact model selection remains available.
