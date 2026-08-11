---
'@namzu/bedrock': minor
---

the bedrock health check can pass, and says which failure it saw

`healthCheck()` hardcoded `anthropic.claude-haiku-4-20250514` — the exact
unversioned form this driver's own `assertModelReachable` refuses. It built its
command directly, so the predicate never ran locally: the service rejected the
id, and `catch { return false }` reported that rejection as an outage. The check
returned `false` with correct credentials, a correct region and a service that
was entirely up, and nothing could tell that apart from a real failure.

**What you do.** Pass the model you run:

```ts
const healthy = await provider.healthCheck('anthropic.claude-sonnet-4-20250514-v1:0')
```

`healthCheck()` still returns `Promise<boolean>` and still takes no required
argument, so nothing stops compiling. Called with no model it now returns
`false` without a network call, because this driver's config holds no model and
there is nothing to probe — the same value it returned before, and it could not
return any other one.

When the answer matters, call `doctorCheck(model)`. It returns the same probe
with its reasoning intact: `status` (`pass` / `fail` / `warn` / `inconclusive` /
`skipped`) plus a machine-readable `reason` separating a rejected credential
from a model this region does not serve, from a request the service refused,
from a throttle, from a timeout that established nothing. The return type of
`healthCheck` was deliberately NOT widened: every caller writing
`if (await provider.healthCheck())` would keep compiling and start always
passing against a truthy result object.

The probe now sends `ConverseStream` — the operation `chatStream` sends — so it
exercises `bedrock:InvokeModelWithResponseStream` rather than a permission your
real calls never use, and it reads the failures Bedrock reports as stream events
after a 200 rather than treating the handshake as the answer.

**`listModels()` model ids changed.** It advertised
`anthropic.claude-sonnet-4-20250514` and `anthropic.claude-haiku-4-20250514`;
both are ids the request path rejects, so an operator who picked either off the
menu got a throw before any call was made. They are now
`anthropic.claude-sonnet-4-20250514-v1:0` and
`anthropic.claude-haiku-4-5-20251001-v1:0`, which are the `bedrock-runtime`
Model IDs on the vendor's own model cards. There was never a "Claude Haiku 4".
If you copied an id out of this catalogue, it did not work; take the versioned
one, or the inference-profile form (`us.`, `eu.`, `apac.`, `jp.`, `global.`) for
a model served cross-region.

`BedrockHealthReason` and `BedrockHealthReport` are exported from the package
root.
