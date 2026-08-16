---
'@namzu/sdk': minor
---

`web_fetch` and `web_search`, declaring `category: 'network'` so they inherit the permission surface — and a read-only network tool no longer auto-approves itself.

Both tools declare `category: 'network'`, which is what the authorization presets branch on. Under `sandboxed` and `sandboxed-shell` they go to a human; only `unattended` — the preset that requires the sandbox to enforce network isolation — auto-approves them. The tests assert that against the real gate rather than against a property of an object, because the category is only meaningful through the gate.

**That claim was false when the tools landed, and fixing it is half this change.** `presets.ts` has always documented that a `network` tool goes to review under the sandboxed presets. It did not: `allow_read_only` is appended last as a default for tools nobody wrote a rule about, and it resolved purely through `isTrustedReadOnly` — which asks whether the read-only *claim* is trustworthy and never what channel the call travels over. A read-only network call matched the default and was approved without review, in the preset whose own docblock said it would not be.

So the allowance is narrowable by category: `allowReadOnlyExcludeCategories` rides along on the rule the gate appends, and both sandboxed presets exclude `network`. Trusting a claim and matching the default stop being the same question. The field is optional rather than defaulted — `undefined` and `[]` are read identically, and defaulting it would break every hand-authored gate config for no behavioural gain.

**Breaking:** a read-only tool in an excluded category that used to auto-approve under `defaultSandboxedGateConfig` or `defaultSandboxedShellGateConfig` now goes to review. A host that wants the old behaviour passes `allowReadOnlyExcludeCategories: []` explicitly.

`web_search` was already a name in this tree: two fixtures invented it, one for a deferred-loading catalog test and one for a network gate test, both describing a tool nobody had written. Reconciled rather than renamed.

Neither tool is in the default builtin set, and `search` missing is the ordinary case — this kernel ships no search backend. The tools say which piece is absent, so an operator can tell a wiring decision from a fault.
