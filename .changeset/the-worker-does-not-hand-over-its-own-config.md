---
'@namzu/sandbox': major
---

The sandbox worker no longer hands its own configuration to the code it contains

Every command the agent runs was spawned with `{ ...process.env, ...body.env }` — the worker's **entire** environment, copied into every child by construction, on every call, and visible in a bare `env` in any shell transcript.

That is a stronger exposure than "untrusted code could read `/proc/self/environ` if it thought to look". It is active propagation: the agent does not have to go looking.

What rode along: `NAMZU_SANDBOX_WORKSPACE`, `NAMZU_SANDBOX_READ_ROOTS` and `NAMZU_SANDBOX_WRITE_ROOTS` — **the confinement layout itself, handed to the code being confined** — plus every other worker setting. The boundary announced its own shape to the thing it was drawn around.

Variables prefixed `NAMZU_SANDBOX_` are now stripped from the inherited environment.

**Stripping by prefix rather than by an allowlist of known-safe names is the load-bearing choice**, and it is the difference between this working and this quietly breaking egress:

- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are set on the container **on purpose**, so tooling inside routes through the egress boundary. An allowlist assembled from first principles drops them, and every proxied workload silently stops being proxied — which looks exactly like the policy working.
- A host's own `options.env` arrives on the same channel and is meant to reach commands. Once both are in `process.env` it is indistinguishable from the worker's config; the prefix is the only thing that tells them apart.

`body.env` is applied **after** the strip and is not filtered. Inheritance is implicit and gets the default; an explicit per-call value is a caller deciding, including one that deliberately sets a prefixed name.

**What changes for you.** A command that read `NAMZU_SANDBOX_WORKSPACE`, `NAMZU_SANDBOX_READ_ROOTS` or `NAMZU_SANDBOX_WRITE_ROOTS` out of its own environment no longer sees them. Pass the value explicitly — `exec`'s `env`, or the provider's `options.env` under a name of your own — if a workload genuinely needs it. The workspace root is also the command's `cwd`, which is how most callers were getting it already.

`major` because the environment a spawned command observes is behaviour a consumer can depend on, even though nothing in the type surface changed.
