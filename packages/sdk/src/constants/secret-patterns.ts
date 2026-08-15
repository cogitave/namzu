/**
 * Credential shapes redacted before they leave this tree, in one place.
 *
 * Two tables evolved independently and disagreed:
 *
 *  - `runtime/query/guardrail-presets.ts` carried eight vendor-prefix-anchored
 *    patterns, private and unexported, deliberately narrow — a loose
 *    "looks like a secret" regex over model output produces false positives
 *    on ordinary code, and a redactor that fires on the wrong thing gets
 *    switched off, at which point it protects nothing.
 *  - `provider/errors.ts` carried a broader, field-name-aware set (a
 *    generic key-prefix pattern, a bearer-header pattern, and a JSON
 *    field-name scrubber that catches a secret by the key it sits under
 *    regardless of value shape) because the narrow approach had already
 *    proven insufficient there: a vendor error body echoes the request,
 *    and a request can carry a credential shape the narrow table never
 *    anticipated.
 *
 * Both live here now, as two exported sets rather than one, because the
 * cost of a false positive is not the same at the two call sites:
 *
 *  - `OUTPUT_SECRET_PATTERNS` (the original narrow eight) is what
 *    `secretRedactionGuardrail` matches against MODEL OUTPUT. A false
 *    positive there rewrites the answer the caller asked for, so it stays
 *    narrow on purpose.
 *  - `LOG_SECRET_PATTERNS` (the union of both tables) is for text that is
 *    being logged or carried in an error's `detail`, never returned as the
 *    answer itself. A false positive there redacts one word out of a
 *    diagnostic line nobody was going to copy-paste as a credential, which
 *    is a cost worth paying for the wider net.
 *
 * `SecretPattern` label strings are never returned to the caller verbatim —
 * consumers replace a match with `[REDACTED:<label>]`, not the matched
 * text, so a `label` here should never itself carry anything secret.
 *
 * Zero imports. This is a leaf module on purpose: `utils/logger.ts` is
 * imported by most of `runtime/query/`, so pulling this table back out of
 * `runtime/query` would have made it a same-package import cycle, and a
 * cycle on a security-relevant table fails as a TDZ error or a
 * partially-initialised module — quietly, in the worst possible place.
 * Keeping this file leaf-only is what lets `runtime/query/guardrail-presets.ts`
 * and `provider/errors.ts` both import from it without one importing the
 * other.
 */

export type SecretPattern = readonly [label: string, pattern: RegExp]

/**
 * The narrow, prefix-anchored set. Unchanged from the table this replaces —
 * same labels, same regexes, same order — because moving it was the whole
 * point of this module and widening it was not: `secretRedactionGuardrail`
 * still needs a redactor precise enough that it never gets switched off.
 */
export const OUTPUT_SECRET_PATTERNS: readonly SecretPattern[] = [
	['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
	['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
	['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
	['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
	['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
	['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g],
	['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
]

/**
 * The union: every pattern above, plus everything `provider/errors.ts`
 * carried that the narrow set did not cover — a generic key-prefix catch,
 * a bearer-header pattern, and a JSON field-name scrubber.
 *
 * Two adjustments over a plain concatenation, both required so that
 * deleting any ONE entry changes behaviour for exactly the shape that
 * entry names, which is what the test suite for this module pins:
 *
 *  - `github-token` uses the wider `{20,}` threshold `provider/errors.ts`
 *    used, not the guardrail's `{36,}` — the union takes the broader of
 *    two disagreeing thresholds for the same vendor, never the narrower.
 *  - The two broad `sk-`-family entries each carry a negative lookahead
 *    excluding the `sk-ant-` and `sk-proj-` shapes, which a plain
 *    `sk-`/`pk-`/`rk-` prefix scan would otherwise ALSO match. Without the
 *    lookaheads, deleting the narrower entry for one of those shapes leaves a
 *    value of that shape still caught — by the broad entries, in array order —
 *    so the redaction succeeds while the label names the wrong issuer.
 *
 *    A mislabelled redaction is not a cosmetic problem: the label is what an
 *    operator greps for when rotating one credential and not another. That is
 *    also why the mutation check deletes each entry in turn and asserts only
 *    its own sample breaks.
 */
export const LOG_SECRET_PATTERNS: readonly SecretPattern[] = [
	['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
	['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
	['openai-key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
	['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
	['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
	['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g],
	['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
	['npm-token', /\bnpm_[A-Za-z0-9]{20,}\b/g],
	['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi],
	['generic-key', /\b(?:sk[-_](?!ant-|proj-)|pk[-_]|rk[-_])[A-Za-z0-9_-]{12,}\b/g],
	['json-secret-field', /"(?:api[_-]?key|authorization|token|secret|password)"\s*:\s*"[^"]*"/gi],
]
