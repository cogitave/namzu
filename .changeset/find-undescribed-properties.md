---
"@namzu/sdk": minor
---

Added `findUndescribedProperties(schema)`, exported alongside `findPortableSchemaViolations` from the package root. It walks a rendered tool schema and returns every named object property, at any depth, whose schema carries no non-empty `description` — the same non-throwing, test-time sweep shape as the portability check, for a different defect: a Zod field with no `.describe()` reaches the model with no account of what it is for. Purely additive; nothing existing changes behavior.
