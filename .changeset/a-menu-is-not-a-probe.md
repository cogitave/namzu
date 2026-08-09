---
'@namzu/sdk': minor
'@namzu/cli': minor
'@namzu/anthropic': minor
'@namzu/openrouter': minor
'@namzu/openai': minor
'@namzu/ollama': minor
---

A wrong API key is no longer reported as working

Typing a key into the picker ran a check that could not fail for two providers.
Measured against deliberately invalid keys, both said the key was good.

**With an OpenRouter key, any string at all passed.** A typo, the wrong
clipboard entry, a revoked key — all were accepted and reported as verified. The
check listed the model catalogue and treated a successful list as a passed
check, and OpenRouter's catalogue endpoint does not authenticate, so it answered
the same way whatever was sent. Nothing was wrong with that driver's listing; a
catalogue was simply never evidence about a key.

**With an Anthropic key, a real rejection was discarded.** The listing caught
the `401` and returned a hardcoded three-model list, which the check read as
success — so the truth existed, was thrown away, and was replaced by something
that looked like an answer.

A credential check is now a separate, declared capability. A driver that
declares no probe is reported as **not checked**, never as verified, so a driver
added in future cannot silently inherit a check it does not perform. Anthropic,
OpenRouter, OpenAI and Ollama declare one; OpenRouter's asks about the key
rather than the catalogue.

Refusal and doubt stay distinct. A `401` means the key is genuinely refused; a
timeout or a DNS failure means nothing was learned, and is reported that way —
telling someone on a broken connection to rotate a working key is a different
error, not a smaller one.

**Anthropic's model listing also never once ran.** The SDK method was pulled out
of its namespace and called bare, so it lost `this`, threw a `TypeError` on
every call, and was swallowed by the same catch — the hardcoded models were not
a fallback but the only answer the method could give. It now calls the live
endpoint, and falls back only when that genuinely fails.

The four driver packages are `minor` rather than `patch`: each gains a method
it did not have, and added functionality is a minor whatever the size of the
diff. Anthropic's earns it twice over, because its listing now returns the live
catalogue where it previously returned the same three hardcoded entries to every
caller - so the value every existing caller receives changes.