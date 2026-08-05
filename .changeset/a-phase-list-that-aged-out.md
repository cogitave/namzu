---
'@namzu/sdk': patch
---

`PrepareStepResult.activeTools` documented the opposite of what it does.

Its comment promised that unregistered names are dropped so a phase list
outliving a tool rename would "narrow the surface, not kill the agent mid-run".
Since the list began bounding what may RUN rather than only what the model is
shown, dropping every name leaves the step able to call nothing — so the code
and its own documentation had said different things.

**The behaviour is right and the comment was wrong.** This list means "only
these": when a rename outlives it, the only set satisfying "only the tools that
no longer exist" is the empty one. Widening back to the run's list would grant
precisely the tools the caller asked to exclude, on the grounds that their own
list failed — a control that stops applying because it was aged out, which is
worse than a step that answers from what it already has. The run continues
either way; nothing crashes.

The warning now distinguishes the two cases, because they have different
consequences: some names dropped narrows the step, and all of them dropped
leaves it unable to call anything. "Ignoring them" was accurate for the first
and misleading for the second.

**Worth knowing if you rely on this:** the warning goes to the logger, so a host
that silences its logger sees a phase quietly stop doing anything. That is a real
gap and it is named here rather than papered over.
