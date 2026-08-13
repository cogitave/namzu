import type {
	GuardrailVerdict,
	NamedGuardrail,
	OutputGuardrail,
	ToolResultGuardrail,
	ToolResultVerdict,
} from '../../types/guardrail/index.js'

/**
 * Patterns for credentials that must never leave a run.
 *
 * Deliberately narrow and prefix-anchored. A loose "looks like a secret"
 * regex over agent output produces false positives on ordinary code, and a
 * redactor that fires on the wrong thing gets switched off — at which
 * point it protects nothing.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
	['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
	['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
	['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
	['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
	['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
	['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g],
	['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
]

export interface SecretRedactionOptions {
	/**
	 * `redact` replaces each match with a placeholder and lets the answer
	 * through; `block` refuses the whole result.
	 *
	 * Redaction is the default because the alternative discards a correct
	 * answer over one token, and a gate that costs the user their work
	 * gets turned off.
	 */
	readonly onMatch?: 'redact' | 'block'
	/** Extra patterns, e.g. an internal token format. */
	readonly extraPatterns?: ReadonlyArray<readonly [label: string, pattern: RegExp]>
}

/**
 * Stop credentials reaching the caller.
 *
 * The concrete failure this exists for: an agent reads a credential file —
 * a legitimate read that every tool gate correctly allows — the secret
 * enters context, and it is repeated in the final answer. Every other gate
 * in namzu sits upstream of that moment.
 */
export function secretRedactionGuardrail(
	options: SecretRedactionOptions = {},
): NamedGuardrail<OutputGuardrail> {
	const patterns = [...SECRET_PATTERNS, ...(options.extraPatterns ?? [])]
	const mode = options.onMatch ?? 'redact'

	return {
		name: 'secret-redaction',
		check: ({ output }): GuardrailVerdict => {
			const found: string[] = []
			let redacted = output

			for (const [label, pattern] of patterns) {
				// Fresh lastIndex: these are module-level /g regexes and are
				// reused across runs.
				pattern.lastIndex = 0
				if (!pattern.test(output)) continue
				found.push(label)
				pattern.lastIndex = 0
				redacted = redacted.replace(pattern, `[REDACTED:${label}]`)
			}

			if (found.length === 0) return { action: 'pass' }

			const summary = [...new Set(found)].join(', ')
			return mode === 'block'
				? { action: 'block', reason: `output contained credentials (${summary})` }
				: { action: 'rewrite', output: redacted, reason: `redacted credentials (${summary})` }
		},
	}
}

/**
 * Phrases that only appear when someone is trying to override the agent's
 * instructions.
 *
 * Detection is genuinely partial and this preset says so rather than
 * implying coverage: an injection written in a language the list does not
 * cover, or phrased as ordinary prose, passes. It raises the cost of the
 * lazy attack; it is not a boundary.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
	/ignore (?:all |any )?(?:your |the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|rules)/i,
	/disregard (?:all |any )?(?:your |the )?(?:previous|prior|above|system) (?:instructions|prompts?|rules)/i,
	/you are (?:now |actually )?(?:in )?(?:developer|debug|god|admin|dan) mode/i,
	/(?:reveal|print|output|repeat|show)(?: me)? (?:your |the )?(?:system prompt|initial instructions|hidden rules)/i,
	/pretend (?:that )?you (?:are|have) no (?:restrictions|rules|guidelines)/i,
]

/**
 * Flag likely instruction-override attempts in the run's input.
 *
 * Input-side because it is cheapest there — nothing has been spent — and
 * because the same text reaching the model is the thing you are trying to
 * prevent.
 *
 * It cannot see an INDIRECT injection, and that is not a limitation of the
 * patterns: an injection carried in a web page or a connected server's
 * answer never appears in the run's input at all. See
 * {@link toolResultInjectionGuardrail}, which is the same list at the other
 * boundary.
 */
export function promptInjectionGuardrail(): NamedGuardrail<
	(ctx: { messages: readonly { readonly content: unknown }[] }) => GuardrailVerdict
> {
	return {
		name: 'prompt-injection',
		check: ({ messages }): GuardrailVerdict => {
			for (const message of messages) {
				const text = typeof message.content === 'string' ? message.content : ''
				for (const pattern of INJECTION_PATTERNS) {
					if (pattern.test(text)) {
						return {
							action: 'block',
							reason: 'input matched a known instruction-override pattern',
						}
					}
				}
			}
			return { action: 'pass' }
		},
	}
}

/**
 * Flag likely instruction-override attempts in what a TOOL returned.
 *
 * The case the input-side screen structurally cannot reach. An indirect
 * injection arrives in a fetched page or a connected server's answer, so it
 * is never in the run's input — by the time it matters the run is
 * legitimate and the payload is riding on a result the model asked for.
 *
 * `refuse`, not `halt`: a hostile result is a reason to abandon that call,
 * not the run. The model is told the answer was refused and can choose
 * something else, which is the behaviour that keeps the control switched on
 * — a screen that ends a run on a false positive gets removed, and then it
 * protects nothing.
 *
 * **Detection is partial and this says so rather than implying coverage.**
 * The pattern list is shared with the input-side screen, so the same caveat
 * holds: an injection phrased as ordinary prose, or written in a language
 * the list does not cover, passes. Pattern-matching and delimiting both
 * measure poorly against an attacker who adapts. This raises the cost of
 * the lazy attack; it is not a boundary, and nothing here should be
 * described as one.
 */
export function toolResultInjectionGuardrail(): NamedGuardrail<ToolResultGuardrail> {
	return {
		name: 'tool-result-injection',
		check: ({ output, provenance }): ToolResultVerdict => {
			for (const pattern of INJECTION_PATTERNS) {
				if (!pattern.test(output)) continue
				// Naming the source is most of what the model needs in order
				// to act. "A result was refused" is not something it can route
				// around; "the answer from weather-co was refused" is.
				const source = provenance ? `the connected server "${provenance.server}"` : 'this tool'
				return {
					action: 'refuse',
					reason: `the result from ${source} matched a known instruction-override pattern`,
				}
			}
			return { action: 'pass' }
		},
	}
}
