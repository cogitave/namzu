---
'@namzu/bedrock': patch
'@namzu/sandbox': patch
---

Stop dropping tool-failure status on Bedrock, and stop accepting a sandbox
egress policy this backend cannot enforce.

- **Bedrock** flattened every failed tool result into an ordinary success.
  The executor computed `isError`, the SSE and A2A bridges carried it, and
  the driver dropped it — even though Converse has a first-class
  `toolResult.status`. The model's trained tool-failure recovery path keys
  off that field, so namzu was relying on prose formatting to convey "that
  call failed".

  Scope note: the five OpenAI-shaped drivers are NOT affected, because
  Chat Completions has no error field on a tool message at all. The error
  reaches those models inside the result text, which is the only channel
  the protocol has.

- **Docker sandbox** accepted `EgressPolicy` and silently ignored it. A
  host that set `deny-all` believed the container had no network and it had
  whatever `network` was configured. A security control that is accepted
  and ignored is worse than one that does not exist. Now: `deny-all` maps
  to `--network none` (which Docker enforces natively), `allow-all` keeps
  the configured network, and `static` / `resolver` **throw** — this
  backend has no proxy to filter hosts through, and downgrading a
  restrictive policy to "allow everything" is exactly the failure worth
  refusing.

- **Docker sandbox** containers now run with `--cap-drop=ALL` and
  `--security-opt=no-new-privileges`, plus an opt-in `runAsUser`.
  `CAP_DAC_OVERRIDE` alone walks past the read-only bind mounts the layout
  sets up, and without `no-new-privileges` a setuid binary in the image
  re-escalates.
