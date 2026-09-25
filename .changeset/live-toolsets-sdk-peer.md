---
'@namzu/live': major
---

`NamzuQueryConfig` now passes `toolsets: readonly Toolset[]` to the SDK instead
of `tools: ToolRegistry`. If you construct a `NamzuModel`, replace its `tools`
field with `toolsets` and wrap tool definitions with `toolset(source,
definitions)`. This release requires `@namzu/sdk >=48.0.0`; use `@namzu/live`
2.x with SDK 44–47.
