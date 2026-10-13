/**
 * Zen answers a keyless free-model request with HTTP 403 and a body saying the free tier is not
 * available to this client. Nothing about the person's key is wrong (none was sent), so the
 * screens say that Zen did not accept the free model and offer the ways on, and keep the
 * service's own words for the Details / debug view.
 */

/** What happened, in the words a person reads. */
export const ZEN_FREE_REFUSED_WHAT = 'Zen didn’t accept the free model right now.'

/** What to do, for a surface with a model picker command. */
export const ZEN_FREE_REFUSED_NEXT =
	'Try again in a while, or choose another provider. A Zen API key also works.'

/** Exactly the keyless free-tier refusal; any other 403 keeps its own copy. */
export function isZenFreeTierRefusal(facts: {
	readonly providerId?: string | undefined
	readonly status?: number | undefined
	readonly detail?: string | undefined
}): boolean {
	return (
		facts.providerId === 'zen' && facts.status === 403 && /free[- ]?tier/i.test(facts.detail ?? '')
	)
}
