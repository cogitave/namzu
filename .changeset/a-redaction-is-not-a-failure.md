---
'@namzu/sdk': minor
---

**A tool result can now be sanitized without being reported as a failure.**
`PluginHookResult` gains `{ action: 'replace', output, content? }` for
`post_tool_use`.

The substitution seam already existed and was typed as a failure channel: the
only way a hook could change what the model sees was `action: 'error'`, which
prefixes `Error: ` and sets the error flag. So redacting a credential out of a
**successful** result was delivered to the model as a tool failure — and a model
told a call failed routes around it, retrying it or reporting to the user that
it did not work. Redaction was reachable and unusable.

`error` says the call went wrong. `replace` says the call went right and the
model may not see all of it:

- the error flag follows the **tool**, not the hook, so a successful call stays
  successful and a failed one stays failed even if a hook rewrites its message;
- no `Error: ` prefix;
- **rich content survives**, because the common case is redacting text from a
  result whose image is unaffected. A hook that needs the blocks gone passes
  `content: []` — and a hook redacting a secret that also appears in an image
  must, since the replace cannot inspect what it is preserving.

`modify` was not reused: it carries `input` and belongs to the pre-call hooks,
so one action would have meant two things depending on where it was returned.
`replace` is rejected on `pre_tool_use` and on the lifecycle events — loudly,
because a hook author who returned it there meant to redact something and would
otherwise watch the secret go through.

**Minor rather than major**, deliberately, and here is the reasoning to
overrule if you disagree: `PluginHookResult` is a type plugin authors
**produce** and the SDK consumes, so widening it cannot break an author's
switch — there is nothing for them to switch over. That is the opposite
direction from the `RunEvent` widening in 12.0.0, which went major because
consumers map every member exhaustively. The four exhaustive switches the
compiler named for this change are all inside this package.
