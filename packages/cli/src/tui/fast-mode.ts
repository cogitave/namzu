/**
 * Fast mode in the terminal: the `/fast` toggle and the `--fast` launch flag.
 *
 * Off by default and never saved: like `--effort`, it chooses how this
 * conversation runs and the next plain `namzu` starts at standard speed again.
 * Fast mode bills at a multiple of the standard rate, so nothing here turns it
 * on by itself, and a model change that cannot keep it turns it off, loudly.
 */

import { thirdPartyHost } from '../integrations/providers/anthropic-endpoint.js'

const FAST_PROVIDER = 'anthropic'

/**
 * Why fast mode cannot run on this provider, endpoint and model right now, or
 * `undefined` when it can. The endpoint matters: `anthropic` also names a
 * compatible or custom `ANTHROPIC_BASE_URL`, where the driver refuses `speed`. The model rule belongs to `@namzu/anthropic` (one table, shared
 * with the request path), which is imported only when asked, so the check costs
 * nothing at startup.
 */
export async function fastModeBlocker(
	providerId: string | undefined,
	model: string | null | undefined,
	now: number = Date.now(),
	otherHost: string | null = thirdPartyHost() ?? null,
): Promise<string | undefined> {
	if (providerId !== FAST_PROVIDER) {
		return 'Fast mode is available on Anthropic models only. Pick one with /model.'
	}
	if (otherHost !== null) {
		return `Fast mode is offered on the vendor's own endpoint only, and requests here go to ${otherHost}.`
	}
	if (!model) return 'Fast mode needs a model; pick one with /model.'
	const { resolveFastModeVerdict } = await import('@namzu/anthropic')
	const verdict = resolveFastModeVerdict(model, now)
	return verdict.ok ? undefined : verdict.reason
}

export function fastOnMessage(): string {
	return 'Fast mode on: faster replies, billed at twice the standard rate. /fast off ends it.'
}

export function fastOffMessage(): string {
	return 'Fast mode off: standard speed and rate.'
}

/** `--fast` named a model that cannot take it; the launch continues at standard speed. */
export function fastLaunchRefusal(reason: string): string {
	return `--fast was not applied: ${reason} Continuing at standard speed.`
}

/** The model changed under fast mode and the new one cannot take it. */
export function fastDroppedMessage(reason: string): string {
	return `Fast mode turned off: ${reason}`
}
