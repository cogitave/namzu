---
'@namzu/sdk': minor
---

`edit` can do the thing its own description tells the model to do.

The tool description says *"For insertions, pass insertLine … use `insertLine: "end"` to extend a file at the end"*, and `write-file` and `bash` point at the same idiom. But `modelInputSchema` advertised only `path`/`old_string`/`new_string`/`replace_all` with `additionalProperties: false`, and `enforceModelInput: true` — so under constrained decoding the append idiom the prompt recommends was the one idiom a model could not emit. A consuming host measured the result over seven days on one tenant: **94 of 159 tool failures** were `edit` rejecting an `insertLine` whose spelling the model had guessed.

`insertLine` is now in the model-facing schema as `oneOf: [integer ≥ 0, "end"]`. Declaring the union that way also removes the synonym problem at its source: for a provider that constrains generation, `"EOF"` is not emittable, because `"end"` is the only string the schema admits.

`old_string` leaves `required`, because an insert has no text to match — requiring it is exactly what made the idiom unexpressible. Which of `old_string` / `insertLine` is present is decided by the two refinements the execution schema already carries. That is deliberate over a top-level `oneOf`: strict structured-output modes are least surprising with a flat object, and a discriminated union at the root is the construct most likely to be rejected or quietly ignored. The cost is that an incomplete call is now expressible and caught at execution rather than generation — paid knowingly, since the alternative is a working capability nothing can reach.

For providers that do **not** constrain, `insertLine` also accepts `eof`, `append`, `last` and `end_of_file`. Liberal at execution and strict in the schema is the right way round: none of those is ambiguous, and refusing one bought strictness at the price of a full model round trip. The rejection message now names the value it received.

Also here, same file family: **`write` refuses a whitespace-only path**, which `edit` has always refused. `.min(1)` admits `"   "`, which resolves to the working directory and fails as an unreadable directory-write error. Two mutating tools disagreeing about the same input is the kind of gap a model finds and a reviewer does not.
