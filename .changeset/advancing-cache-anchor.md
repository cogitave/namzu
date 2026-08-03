---
'@namzu/anthropic': patch
'@namzu/bedrock': patch
---

The conversation cache anchor advances, so the next request can read it.

A single breakpoint at the conversation tail writes a new cache entry every
turn and reads none of them: by the next request the tail has moved, so the
marker sits somewhere the previous entry does not cover. The tools and
system tiers keep hitting through their own breakpoints — which is exactly
what made this invisible. Only the messages tier silently re-billed as a
write.

Both drivers now place a second anchor one turn back, which is where the
previous request put its tail marker and therefore the prefix that is
already cached.

It matters most where the history grows fastest. Pending tool results
collapse into a single message, so a fan-out of ten parallel calls appends
twenty content blocks in one turn — far enough to push the prior boundary
out of reach of a backward scan that stops at the first non-empty message.

This spends the fourth of the four allowed breakpoints, previously
documented as deliberately unspent. It is spent on the one tier that was
never hitting. A conversation with a single message still gets one anchor,
because there is nowhere behind it to put a second.
