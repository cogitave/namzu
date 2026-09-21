---
'@namzu/cli': patch
---

The turn-start repository snapshot (`git status` and recent commits, sent on a
send's first request) now reaches the model as request-only context after the
conversation, not as a system message. On Anthropic, each new send used to
change the system prompt and re-read the whole conversation uncached. Now the
cached conversation is kept and only the snapshot's own tokens are new.

What the model reads changes in two ways: the snapshot arrives in a user-role
message rather than a system message, and it follows the line
`Current step context (runtime-generated; not a new user request):`, which
every request-only context message opens with. The snapshot text itself is
unchanged.
