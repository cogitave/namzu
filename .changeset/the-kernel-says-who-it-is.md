---
'@namzu/sdk': minor
---

Drivers now identify this kernel to the provider they call. New `NAMZU_APP_IDENTITY` and `attributionHeaders(identity?)`, merged at each driver's existing header seam — OpenAI, OpenRouter, the generic HTTP driver, Bedrock, and Anthropic's **api-key path only**.

No driver did this. The single user-agent anywhere was on Anthropic's OAuth path, set because the token-exchange endpoint rejects subscription tokens without it — load-bearing impersonation, not attribution, and untouched here. Merging into that branch would not have improved a label; it would have broken login intermittently, with a 401 or 500 naming none of it.

What attribution buys is not vanity: a vendor reading its own logs can tell a kernel's traffic from a browser's, a rate-limit or abuse investigation lands on the right party, and a driver bug a vendor reports arrives with something to search for.

Exactly one header, asserted by a test that counts the keys — every additional one is something a proxy may strip and a reader has to reconcile. The version is read from the package manifest, never hand-copied. A host may pass its own identity, and the driver seams honour it rather than the constant.

LM Studio and Ollama record `attribution: { kind: 'unsupported', reason }` in their conformance options: their vendor clients own the transport and expose no header seam. The suite requires the declaration either way, so a new driver package cannot skip the decision.
