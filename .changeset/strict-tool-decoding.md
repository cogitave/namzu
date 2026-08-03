---
'@namzu/openai': minor
---

Tool arguments can be made valid by construction

namzu has a whole repair path for arguments that do not match a tool's schema — a repair hook, a bounded retry, a model-visible error. This wire format offers a mode where the endpoint constrains decoding to the schema, so invalid arguments cannot be emitted at all, which is strictly better than repairing them well.

`strictTools: true` turns it on. Off by default because it is a real trade: strict decoding requires every property to be required, so the driver rewrites each schema — objects close, every property joins `required`, and one that was optional widens to accept `null` so "leave it out" stays expressible. An optional argument therefore becomes one the model must pass explicitly as null, and that change to what the model is told belongs to the tool's author rather than the driver.

The rewrite is not separable from the flag: the endpoint rejects strict mode on a schema that has not been closed for it, so sending one without the other would turn a correctness feature into a 400.
