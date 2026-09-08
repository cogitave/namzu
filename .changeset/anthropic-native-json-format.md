---
"@namzu/anthropic": minor
---

Honor responseFormat.json_schema in direct provider calls by sending output_config.format without overwriting reasoning effort. Previously the requested format was silently ignored. Schemas are forwarded unchanged; callers remain responsible for vendor-compatible schemas and checking the response.

Unsupported json_object and explicit strict:false requests now fail locally with a bad_request provider error. Use json_schema with strict:true or omit strict. QueryParams.structuredOutput still uses the output tool; this change does not add a query-level native mode.
