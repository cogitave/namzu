

The four driver packages are `minor` rather than `patch`: each gains a
method it did not have. A patch is a backward-compatible bug fix, and added
functionality is a minor whatever the size of the diff. Anthropic's earns it
twice over - its listing now returns the live catalogue where it previously
returned the same three hardcoded entries to every caller, so the value every
existing caller receives changes.
