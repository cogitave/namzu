---
'@namzu/sdk': patch
'@namzu/cli': patch
---

A sub-agent's result now reaches the parent inside the same marked block as other outside text on every path, not only as a task notification: a foreground `Agent` call, `wait_for_task` and a saved agent's history return the child's words in an `agent-result` block, with the task id and status outside it. The block's header tells the model that an instruction inside it is for the operator to hear about, not to act on. A tool that read the `Agent result:` text of a `wait_for_task` result as plain text should read the block (`untrustedEnvelopeBody` returns its body). The sub-agent prompt no longer tells the child not to ask questions in a way that contradicts the working rules it inherits: it ends by saying that with no one to ask, the child finishes what is safe, leaves the risky step undone and names the blocker in its summary.
