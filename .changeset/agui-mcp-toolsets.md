---
"@namzu/ag-ui": patch
"@namzu/sdk": patch
---

The AG-UI adapter now reads tools and review metadata from the query's toolsets, preserving review exemptions and per-tool timeouts after the ToolRegistry removal. MCP resource tools likewise rely on their owning toolset for source trust instead of a removed per-tool provenance field.
