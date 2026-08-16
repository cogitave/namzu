---
'@namzu/sdk': patch
---

An isolated code runtime seam and its `worker_threads` backend — internal, and not yet on the public surface.

A model that can write a loop does in one call what currently costs twenty: filter a list, retry with backoff, fan out over files. Each of those is a control-flow shape the tool loop expresses by taking a full model turn per step, at full context size, with the whole conversation resent each time.

The difficulty is that the program is untrusted text. Not code an operator installed — a string the model produced, possibly under the influence of a web page it was told to summarise. So the seam is defined by what a backend must **guarantee**: no ambient capability, a single channel back to the host, and bounds on wall clock and output enforced by the backend rather than asked of the program.

`worker_threads` over `vm`, because `vm` is not a sandbox and its own documentation says so: a context shares the process, and `this.constructor.constructor` on any leaked object is the whole escape. Over a subprocess, because a subprocess inherits an environment, can be a fork bomb, and needs the process-tree kill. What a worker does *not* give is stated in the source: it shares the process's filesystem and network. What confines the program is a scope with nothing in it, which is a language-level boundary — exactly as strong as the enumeration of what was withheld. A host needing an OS boundary runs this inside a sandbox that has one.

The allow-list is enforced on the **host** side. A check inside the worker is a check the program shares a heap with.

Nothing is exported yet, deliberately: a seam with one backend and no consumer is a guess at what a consumer needs. The public surface joins in the commit that has one.

Also corrects `coverage-config.json`'s `baselineExempt` list, which the test-presence gate documents as "current zero-tested modules". Seven of its nine entries carried tests — `utils` had twenty-five files — so the list said "these have no tests" about modules that did. A routing document that is false is worse than none, because the next person picks the wrong module to work on. `model-router` and `persona` are the two that genuinely have none.
