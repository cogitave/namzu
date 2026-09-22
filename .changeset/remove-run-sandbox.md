---
"@namzu/sandbox": major
---

No API change. The peer dependency on `@namzu/sdk` moves to the 44 major,
because the SDK itself had a major release (its run became a turn inside a
session). `@namzu/sandbox` reads no renamed field, but its peer range is
published as a caret on the SDK version it was built with, so the SDK major
takes it out of range and forces this bump.

What to do: upgrade `@namzu/sdk` and `@namzu/sandbox` together. Nothing in your
code changes.
