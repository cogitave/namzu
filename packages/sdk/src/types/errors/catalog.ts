import { ProviderError } from '../provider/errors.js'
import { isNamzuError } from './index.js'

/**
 * An ordered rule layer between a caught throwable and the operator.
 *
 * A failure surfaced as whatever prose the vendor SDK happened to write:
 * no stable id to grep for in logs, and no instruction on what to change.
 * There was also no growth point — a newly-observed failure shape could
 * only be given curated copy by editing the classifier itself, which mixes
 * "what kind of failure is this" with "what should a person do about it".
 *
 * The two are separate jobs. Classification is structural and belongs at
 * the boundary; remediation is editorial and belongs in a list a human
 * appends to. `DoctorCheckResult` already proves the pattern is native
 * here: it carries `message` and `remediation` as separate fields, and
 * `namzu doctor` has been the only surface that got either.
 *
 * Rules match on STRUCTURAL signals — code, status, error name, an
 * explicit `hint` own-property from the throw site — never on volatile
 * vendor prose, which changes without warning and differs per SDK version.
 */

/** What a rule knows about a failure, flattened for matching. */
export interface ErrorFacts {
	/** namzu or provider code, whichever classification produced one. */
	readonly code?: string
	readonly status?: number
	/** Constructor name, for a throwable neither classifier recognised. */
	readonly name?: string
	readonly message: string
	/** Server-directed backoff, when one was parsed. */
	readonly retryAfterMs?: number
	/** A hint the throw site attached directly. See {@link readHint}. */
	readonly hint?: string
}

export interface ErrorCatalogRule {
	/**
	 * Stable id. Appears in logs and in operator output, so it is greppable
	 * and can be linked to. Never renamed once shipped — a rule whose
	 * meaning changes gets a new id.
	 */
	readonly id: string
	readonly when: (facts: ErrorFacts) => boolean
	/** What happened, in an operator's terms rather than the vendor's. */
	readonly message: string
	/** What to change. Separate from `message` so a surface can override it. */
	readonly hint: string
}

export interface ErrorExplanation {
	readonly id: string
	readonly message: string
	readonly hint: string
}

/**
 * A hint attached at the throw site.
 *
 * Infrastructure code knows things the classifier cannot infer — that a
 * daemon is not running, that a socket path is wrong — and had no channel
 * to say so except by baking prose into the message, where it cannot be
 * separated from the failure again. An own-property survives every
 * `instanceof` check and every rethrow, and rules can pass it through
 * under a stable id.
 */
export function readHint(err: unknown): string | undefined {
	if (typeof err !== 'object' || err === null) return undefined
	const hint = (err as { hint?: unknown }).hint
	return typeof hint === 'string' && hint.length > 0 ? hint : undefined
}

/** Attach a hint to a throwable without changing its message or type. */
export function withHint<E>(err: E, hint: string): E {
	if (typeof err === 'object' && err !== null) {
		Object.defineProperty(err, 'hint', { value: hint, enumerable: false, configurable: true })
	}
	return err
}

/** Flatten a throwable into the shape rules match on. */
export function factsOf(err: unknown): ErrorFacts {
	const hint = readHint(err)
	const message = err instanceof Error ? err.message : String(err)

	if (err instanceof ProviderError) {
		return {
			code: err.code,
			message,
			name: err.name,
			...(err.status !== undefined ? { status: err.status } : {}),
			...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
			...(hint !== undefined ? { hint } : {}),
		}
	}

	if (isNamzuError(err)) {
		const status = err.details?.status
		return {
			code: err.code,
			message,
			name: err.name,
			...(typeof status === 'number' ? { status } : {}),
			...(hint !== undefined ? { hint } : {}),
		}
	}

	return {
		message,
		...(err instanceof Error ? { name: err.name } : {}),
		...(hint !== undefined ? { hint } : {}),
	}
}

/**
 * The seed rules.
 *
 * Ordered, first match wins — so a rule may be as specific as it likes
 * without having to exclude everything below it. Three to start, chosen
 * because they are the failures an operator hits first and the ones where
 * the vendor's own words help least.
 */
export const DEFAULT_ERROR_RULES: readonly ErrorCatalogRule[] = [
	{
		id: 'hint.from_throw_site',
		// Highest precedence on purpose: code that raised the failure knows
		// more about it than a rule matching on a status code ever will.
		when: (facts) => facts.hint !== undefined,
		message: '',
		hint: '',
	},
	{
		// Before the generic auth rule: the codes collapse 401 and 403 into
		// one, but the two call for different actions and the status still
		// separates them when the provider sent it.
		id: 'provider.permission',
		when: (facts) => facts.status === 403,
		message: 'The credentials are valid but not permitted to use this model.',
		hint: 'The key authenticated, so this is an entitlement rather than a secret problem: check the model name and whether the account has access to it.',
	},
	{
		id: 'provider.auth',
		when: (facts) => facts.code === 'auth' || facts.status === 401,
		message: 'The provider rejected the credentials for this run.',
		hint: 'Check that the API key is set, is not expired, and belongs to the account the model is billed to. Retrying will not help until it changes.',
	},
	{
		id: 'provider.rate_limit',
		when: (facts) => facts.code === 'rate_limit' || facts.status === 429,
		message: 'The provider is rate limiting this run.',
		hint: 'Automatic retries with backoff have already been exhausted. Lower concurrency, or wait for the quota window to reset before resuming.',
	},
	{
		id: 'provider.context_overflow',
		when: (facts) => facts.code === 'context_length_exceeded',
		message: 'The prompt is larger than the model can accept.',
		hint: 'Compaction ran and could not make enough room. Lower `compactionConfig.triggerThreshold`, reduce `keepRecentMessages`, or cap large tool outputs so history stops growing faster than it can be shed.',
	},
	{
		id: 'provider.unavailable',
		when: (facts) =>
			facts.code === 'server_error' ||
			facts.code === 'overloaded' ||
			(facts.status !== undefined && facts.status >= 500),
		message: 'The provider is failing on its own side.',
		hint: 'Nothing in the run is wrong. Resume from the last checkpoint once the provider recovers.',
	},
	{
		id: 'provider.network',
		when: (facts) => facts.code === 'network' || facts.code === 'timeout',
		message: 'The provider could not be reached.',
		hint: 'Check network reachability and any proxy or firewall between this host and the provider endpoint, then resume from the last checkpoint.',
	},
	{
		id: 'provider.model_not_found',
		when: (facts) => facts.code === 'not_found' || facts.status === 404,
		message: 'The provider does not recognise the model or endpoint requested.',
		hint: "Check `runConfig.model` against the provider's current model list — a model id that was valid can be retired, and a deployment-scoped provider needs the deployment name rather than the base model name.",
	},
	{
		id: 'provider.content_filter',
		when: (facts) => facts.code === 'content_filter',
		message: 'The provider refused the request on safety grounds.',
		hint: "This is the provider's policy decision, not a namzu one, and resending the same prompt cannot change it. The refusal usually names the category it triggered.",
	},
]

/**
 * Explain a failure, or return `null` when no rule claims it.
 *
 * `null` rather than a generic fallback: inventing advice for a failure
 * nobody has characterised is worse than saying nothing, because it sends
 * the reader somewhere specific and wrong.
 */
export function explainError(
	err: unknown,
	rules: readonly ErrorCatalogRule[] = DEFAULT_ERROR_RULES,
): ErrorExplanation | null {
	const facts = factsOf(err)
	for (const rule of rules) {
		if (!rule.when(facts)) continue
		// The throw-site rule carries no copy of its own — it exists to give
		// a hint written at the raise point precedence over a generic one.
		if (rule.id === 'hint.from_throw_site') {
			return { id: rule.id, message: facts.message, hint: facts.hint ?? '' }
		}
		return { id: rule.id, message: rule.message, hint: rule.hint }
	}
	return null
}
