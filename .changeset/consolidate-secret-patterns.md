---
'@namzu/sdk': minor
---

Consolidate the two credential-redaction pattern tables into `constants/secret-patterns.ts`

`runtime/query/guardrail-presets.ts` (the output guardrail) and `provider/errors.ts` (vendor-error scrubbing) each carried their own, disagreeing list of credential shapes to redact. They now both import from one leaf module, exported as `OUTPUT_SECRET_PATTERNS` and `LOG_SECRET_PATTERNS`.

`secretRedactionGuardrail`'s own matching set is **unchanged** — it keeps the narrow, vendor-prefix-anchored eight patterns it always had, because a false positive on model output rewrites the caller's answer.

`provider/errors.ts`'s `redactSecrets`/`vendorDetail` now match the **union** of both tables (previously: a generic key-prefix scan, a bearer-header pattern, and a JSON field-name scan). A `ProviderRequestError.detail` string can now be redacted where it previously was not — for example a Slack-style token, a Google-style API key, a PEM private-key header, or a JWT echoed back in a vendor error body, none of which the old generic scan caught.

The redaction marker format also changed, on this call site only: `redactSecrets` used to emit a bare `[redacted]` (or, for the JSON-field case, preserve the field name and quote the placeholder); it now emits `[REDACTED:<label>]` for every match, matching the convention the output guardrail already used. A caller pattern-matching `ProviderRequestError.detail` for the literal string `[redacted]` needs to match `[REDACTED:` instead.

No exported identifier was removed or renamed, and no function signature changed.
