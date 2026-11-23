import { classifyProviderError } from '../../../types/provider/errors.js'

/**
 * The class of a failure to complete the safety check, in a few plain words:
 * `no credential for the check model`, `provider returned 400`,
 * `timed out after 60 s`. It is a class, never the provider's own text: that
 * text can carry a request body or a key fragment, so it goes to the log, not
 * to the person or the model.
 *
 * `deadlineMs` is the deadline the pass ran under, when the failure was the
 * deadline expiring.
 */
export function describeCheckFailure(error: unknown, deadlineMs?: number): string {
	if (error instanceof Error && error.name === 'DeadlineError') {
		return deadlineMs !== undefined
			? `timed out after ${Math.round(deadlineMs / 1000)} s`
			: 'timed out'
	}
	const classified = classifyProviderError(error)
	// An HTTP status names the failure better than any word in the message: a
	// 401 that says "invalid credentials" is a refused credential, not a missing one.
	// The words are read only when there is no status.
	if (classified.status === undefined) {
		const message = error instanceof Error ? error.message : String(error)
		if (
			/no (api )?(key|credential)s?|missing (api )?(key|credential)s?|credentials? (is |are )?(not (set|configured|found)|missing)|not signed in|not logged in|api key (is )?(required|missing|not set)/i.test(
				message,
			)
		) {
			return 'no credential for the check model'
		}
	}
	const status = classified.status
	switch (classified.code) {
		case 'auth':
			return status !== undefined
				? `provider returned ${status}: the credential was refused`
				: 'the credential was refused'
		case 'rate_limit':
			return 'provider rate limit'
		case 'usage_limit':
			return 'provider usage limit reached'
		case 'network':
			return 'could not reach the provider'
		case 'not_found':
			return 'the check model was not found'
		default:
			return status !== undefined ? `provider returned ${status}` : 'provider error'
	}
}
