---
"@namzu/ag-ui": major
"@namzu/sdk": patch
---

The AG-UI adapter now reads tools and review metadata from the query's
`toolsets`, preserving review exemptions and per-tool timeouts after the
`ToolRegistry` removal. Hosts must return `QueryParams.toolsets` from
`createQuery` instead of passing a `ToolRegistry` as `tools`. Wrap definitions
with `toolset(source, definitions)` and require `@namzu/sdk >=48.0.0`; use
`@namzu/ag-ui` 2.x with SDK 45.1–47. MCP resource tools likewise rely on their
owning toolset for source trust instead of a removed per-tool provenance field.
