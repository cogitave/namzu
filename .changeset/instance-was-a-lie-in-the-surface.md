---
'@namzu/cli': minor
---

`--instance` is removed, because it never did anything

`run` and `run-stream` parsed `--instance <name>` into a field that nothing in
the repository read. Its own comment said it chose "which namzu persona
answers"; no persona selection exists. A host that passed it got the behaviour
it asked for exactly never, and was told exactly nothing.

That is worse than an absent flag. An absent flag reports itself the moment you
use it. A flag that parses and is discarded reports nothing until someone
notices the behaviour they asked for never happened — which for a persona
selector could be a long time, or never.

**What breaks:** `namzu run --instance x "…"` and `namzu run-stream --instance x
"…"` now fail with `unknown option(s): --instance` — exit 64 for `run`, an
in-band error event for `run-stream`. Remove the flag from the invocation;
nothing else changes, because nothing else ever depended on it.

**Why no deprecation window.** SemVer's guidance is to precede a removal with a
release that warns, so working code has a version where it still compiles. That
exists to protect code that WORKS. There is no working code to protect here: the
flag had no producer, no reader and no runtime effect, and the repository's
release rule says such a declaration may be removed outright provided the
changeset says so. This one says so.

It was not wired instead, because wiring it would mean inventing persona
selection to justify a flag that was already there — which is how dead
configuration gets written rather than removed.
