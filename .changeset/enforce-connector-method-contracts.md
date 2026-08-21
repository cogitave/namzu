---
'@namzu/sdk': major
---

Make registered connector methods the authoritative execution contract.

`ConnectorManager` now requires the registered definition and concrete
connector to expose the same unique method names, captures that definition at
instance admission, and refuses unknown methods or invalid input before
connector I/O. Input schemas use asynchronous parsing and their canonical
transformed value is passed to the connector exactly once. Successful outputs
are asynchronously validated and transformed when `outputSchema` is present;
an invalid or unprovable output is quarantined instead of reaching a caller,
tool result, MCP response, or later model request.

**What breaks:** connectors can no longer execute undeclared methods, consume
raw pre-transform input through `ConnectorManager`, return schema-invalid data
as success, or change a live instance's method surface by replacing its
registry entry. Align the concrete connector and registered definition before
creating an instance. Third-party `BaseConnector` subclasses that call
`validateInput` inside `execute` must change that call to
`await this.validateInput(method, input, options)` so a managed canonical value
is not parsed twice; standalone calls remain validated.

Per-method tools now keep their model-facing method schema separate from their
pass-through runtime decoder, and MCP projections carry connector output
schemas, including non-object JSON Schema values. `MCPToolDefinition.outputSchema`
therefore widens from object-only `MCPJsonSchema` to `MCPValueJsonSchema`.
