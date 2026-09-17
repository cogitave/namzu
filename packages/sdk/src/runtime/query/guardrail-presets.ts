import { OUTPUT_SECRET_PATTERNS } from '../../constants/secret-patterns.js'
import { untrustedEnvelopeBody } from '../../tools/untrusted-envelope.js'
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
 * Deliberately narrow and prefix-anchored, unchanged by the move to
 * `constants/secret-patterns.ts`: a loose "looks like a secret" regex over
 * agent output produces false positives on ordinary code, and a redactor
 * that fires on the wrong thing gets switched off — at which point it
 * protects nothing. The wider, field-name-aware set `provider/errors.ts`
 * needs lives in the same leaf module as `LOG_SECRET_PATTERNS`; it is not
 * used here because a false positive on THIS boundary rewrites the
 * caller's answer, and a false positive there only costs a redacted log
 * value.
 */
const SECRET_PATTERNS = OUTPUT_SECRET_PATTERNS

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

/**
 * Requests shorter than this are not compared against the result.
 *
 * A one-word echo cannot be told from a one-word answer, and the shorter the
 * value the likelier it is to recur in a legitimate result by coincidence:
 * `ls` of a directory holding one entry called `src`, called with
 * `{ path: "src" }`, returns `src`. The value of catching a five-character
 * restatement is nil — nothing rides on it — so the comparison starts where
 * a restatement actually means something.
 */
const MIN_RESTATEMENT_LENGTH = 16

export interface ToolResultCorrespondenceOptions {
	/**
	 * Tools whose answer IS the request, and must not be refused for saying
	 * so: a validator returning what it validated, a normaliser returning the
	 * normalised form, a dry run echoing what it would have done.
	 *
	 * This is the escape hatch the check needs rather than a tuning knob. The
	 * screen is right about a tool that was asked a question and handed the
	 * question back; it is wrong about a tool whose purpose is to hand
	 * something back, and nothing on the context distinguishes the two.
	 */
	readonly passthroughTools?: readonly string[]
}

interface RequestText {
	/** Where in the request the text sits, e.g. `city` or `filters.city`. */
	readonly path: string
	readonly text: string
}

function normalizeText(text: string): string {
	return text.trim().replace(/\s+/g, ' ')
}

/**
 * Every string the call was made with, and where it sat.
 *
 * Strings only. A number is a plausible answer — a count of 10, a port of
 * 8080 — and comparing one would fire on `{ maxResults: 10 }` answered with
 * `10`, which is a legitimate result from a legitimate tool.
 */
function collectRequestText(value: unknown, path: string, into: RequestText[]): void {
	if (typeof value === 'string') {
		const text = normalizeText(value)
		if (text.length >= MIN_RESTATEMENT_LENGTH) into.push({ path, text })
		return
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			collectRequestText(item, `${path}[${index}]`, into)
		}
		return
	}
	if (value === null || typeof value !== 'object') return
	for (const [key, nested] of Object.entries(value)) {
		collectRequestText(nested, path === '' ? key : `${path}.${key}`, into)
	}
}

/**
 * Refuse a result that is the request rather than an answer to it.
 *
 * #399 recorded that a screen at this boundary cannot know what a tool SHOULD
 * have answered, and the issue that asked for this screen named three
 * mismatches — a weather lookup for one city answering about another, a read
 * of one path returning another's contents, a search returning instructions
 * rather than results. **This screen decides none of the three.** The first
 * two need a declaration of which argument names the subject, and the
 * framework cannot infer one: for a file read the answer is the file's
 * contents, which do not name the path, so the natural rule — an answer
 * mentions its subject — would refuse every ordinary read. The third is what
 * {@link toolResultInjectionGuardrail} already screens for at this same
 * boundary, and re-implementing it here would give the two the same blind spot
 * rather than the different one this adds.
 *
 * What is left is the one correspondence failure that needs no domain
 * knowledge and cannot be an answer: **the result restates the request**. A
 * tool handed a question and returning that question has answered nothing,
 * whatever it is a tool for — and a tool whose result is the call text is
 * either broken or doing something the call did not ask for. The comparison
 * is exact equality after whitespace normalisation against each string the
 * call carried, so a result that says anything extra — the answer plus
 * anything at all — passes.
 *
 * Three things this deliberately does not touch:
 *
 *  - **An empty result for a non-empty request.** Real, and not a signal:
 *    a search that matched nothing and a file with nothing in it both return
 *    nothing, and refusing either tells the model to stop looking when there
 *    was nothing to find.
 *  - **A shape contradicting `ToolDefinition.outputSchema`.** The schema is
 *    not on {@link ToolResultGuardrailContext} and is documented as shown to
 *    the model, never validated. Carrying it and enforcing it are changes to
 *    that contract, not this screen's to make.
 *  - **A failed call.** On `success: false` the text is a diagnostic, and
 *    `screenToolResult` replaces the output when it refuses — so refusing
 *    here would trade an echo nobody needs to catch for the error message
 *    the model needs to read.
 *
 * The comparison runs on the frame as well as on the text: a connector's
 * result reaches a screen already wrapped by `wrapUntrusted`, so comparing
 * the raw output would never match the one case this is most worth having —
 * a connected server returning the request. Both the whole output and, when
 * it is one wrapped block, the body inside it are compared.
 *
 * Detection is partial and this says so rather than implying coverage: an
 * answer about the wrong subject, an answer that is plausible prose, and a
 * restatement shorter than {@link MIN_RESTATEMENT_LENGTH} all pass.
 */
export function toolResultCorrespondenceGuardrail(
	options: ToolResultCorrespondenceOptions = {},
): NamedGuardrail<ToolResultGuardrail> {
	const passthrough = new Set(options.passthroughTools ?? [])

	return {
		name: 'tool-result-correspondence',
		check: ({ toolName, input, output, success }): ToolResultVerdict => {
			if (!success || passthrough.has(toolName)) return { action: 'pass' }

			const request: RequestText[] = []
			collectRequestText(input, '', request)
			if (request.length === 0) return { action: 'pass' }

			const body = untrustedEnvelopeBody(output)
			// The whole output, and the body when the output is one wrapped
			// block. The two are never the same string — the frame carries the
			// tags — so this is two comparisons, not the same one twice.
			for (const text of [normalizeText(output), normalizeText(body ?? '')]) {
				if (text === '') continue
				const restated = request.find((entry) => entry.text === text)
				if (!restated) continue
				return {
					action: 'refuse',
					reason: `the result returns the "${restated.path}" argument this call sent, verbatim and on its own, so it is the request rather than an answer to it`,
				}
			}

			return { action: 'pass' }
		},
	}
}
