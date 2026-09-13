---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Correct recovery guidance in shortened tool output. The kernel no longer assumes that workspace `read`/`grep` tools can open internal retained-output paths. It directs recovery through the host-authorized tools and distinguishes the saved observation from a fresh read of its source. Existing permissions, exact retention and preview limits are unchanged; previously recorded previews are not rewritten.
