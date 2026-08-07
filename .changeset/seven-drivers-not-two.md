---
"@namzu/sdk": patch
---

Stop the package README naming two providers when seven ship

"Provider abstraction. OpenRouter and AWS Bedrock today" has been wrong for a
long time. Seven driver packages ship — and a reader deciding whether this
kernel can talk to the service they already pay for was being told, on the
registry page, that it probably cannot.

That is the expensive direction for this particular sentence to be wrong in:
it does not cause a bug, it causes someone to close the tab.

Also removed the third-party product names from "What Namzu Is Not". That
section explained namzu's scope by listing other people's products, which is
the one thing this repository's own naming rule refuses — a design explained
by reference to somebody else's has borrowed its shape, and the borrowing
outlives the sentence. The scope boundaries are unchanged and now stated as
categories: no front-end framework bindings, no web-framework or edge-runtime
plumbing, no embedded vector engine.

Prose only. No runtime change.
