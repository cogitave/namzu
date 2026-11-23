---
'@namzu/sdk': major
---

The default label of a tool call changed. `genericLabel` returns an empty string, not a JSON dump of the arguments, when no field of the input reads as a name (an id or a flag is not one), and it also reads `url`, `name`, `title` and `select`. A host that prefixed the tool name to the label should show the name alone for an empty label. Hosted search chunks may carry `searches`, the number of queries one call ran. `search_tools` now has its own call and result lines, and indents the continuation lines of each tool description in its reply.
