/**
 * Fast mode in the terminal: the `/fast` toggle and the `--fast` launch flag.
 *
 * Off by default. `/fast` and `--fast` choose how this conversation runs and are
 * never saved; the `fast` setting is the saved way to start with it on.
 * Fast mode bills at a multiple of the standard rate (or uses more of a
 * subscription's allowance), so nothing here turns it
 * on by itself, and a model change that cannot keep it turns it off, loudly.
 */

import { thirdPartyHost } from '../integrations/providers/anthropic-endpoint.js'

/** `fast` is the premium tier; `ultrafast` is the one above it, offered through the Codex subscription only. */
export type FastTier = 'fast' | 'ultrafast'

/** Who serves the tier, and so what using it costs. */
export type FastProvider = 'anthropic' | 'openai' | 'codex'

export interface FastRate {
	/** `billing`: a multiple of the per-token rate. `plan`: the plan allowance drains faster. */
	readonly kind: 'billing' | 'plan'
	/** Stated by a source for this model; absent when none is, and then no number is shown. */
	readonly multiplier?: number
}

export type FastModeVerdict =
	| {
			readonly ok: true
			readonly provider: FastProvider
			readonly tier: FastTier
			readonly rate: FastRate
	  }
	| { readonly ok: false; readonly reason: string }

export interface FastModeOptions {
	/** The tier asked for; `fast` when absent. */
	readonly tier?: FastTier
	/** Epoch ms; a parameter so a removal date can be tested without waiting for it. */
	readonly now?: number
	/**
	 * The host requests go to when it is not the vendor's own. Absent reads the
	 * environment for the provider; `null` says there is none.
	 */
	readonly otherHost?: string | null
	/** The tiers the Codex subscription's model listing offers for the model; absent until it has loaded. */
	readonly advertised?: readonly FastTier[]
}

/** The host the base URL variable names, only when it is not the vendor's own. */
export function openAIThirdPartyHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.OPENAI_BASE_URL?.trim()
	if (!raw) return undefined
	try {
		const host = new URL(raw).hostname
		return host === 'api.openai.com' ? undefined : host
	} catch {
		return undefined
	}
}

/**
 * Whether fast mode can run on this provider, endpoint and model right now,
 * and at what rate. The endpoint matters: the same provider id also covers a
 * compatible or custom base URL, where the driver refuses `speed`. The model
 * rules live in the provider packages (one table each, shared with the request
 * path), imported only when asked, so the check costs nothing at startup.
 */
export async function fastModeVerdict(
	providerId: string | undefined,
	model: string | null | undefined,
	options: FastModeOptions = {},
): Promise<FastModeVerdict> {
	const tier = options.tier ?? 'fast'
	const now = options.now ?? Date.now()
	const refuse = (reason: string): FastModeVerdict => ({ ok: false, reason })
	if (providerId !== 'anthropic' && providerId !== 'openai' && providerId !== 'codex') {
		return refuse(
			'Fast mode is available on Anthropic and OpenAI models only. Pick one with /model.',
		)
	}
	if (providerId === 'anthropic') {
		const otherHost =
			options.otherHost === undefined ? (thirdPartyHost() ?? null) : options.otherHost
		if (otherHost !== null) {
			return refuse(
				`Fast mode is offered on the vendor's own endpoint only, and requests here go to ${otherHost}.`,
			)
		}
		if (!model) return refuse('Fast mode needs a model; pick one with /model.')
		if (tier === 'ultrafast') {
			return refuse('Ultrafast is not offered on Anthropic models. /fast turns on fast mode.')
		}
		const { resolveFastModeVerdict } = await import('@namzu/anthropic')
		const verdict = resolveFastModeVerdict(model, now)
		return verdict.ok
			? { ok: true, provider: 'anthropic', tier: 'fast', rate: { kind: 'billing', multiplier: 2 } }
			: refuse(verdict.reason)
	}
	if (!model) return refuse('Fast mode needs a model; pick one with /model.')
	const otherHost =
		providerId === 'openai'
			? options.otherHost === undefined
				? (openAIThirdPartyHost() ?? null)
				: options.otherHost
			: null
	const { resolveFastModeVerdict } = await import('@namzu/openai')
	const verdict = resolveFastModeVerdict({
		route: providerId === 'openai' ? 'api' : 'subscription',
		model,
		tier,
		firstPartyEndpoint: otherHost === null,
		...(otherHost !== null ? { host: otherHost } : {}),
		...(options.advertised !== undefined ? { advertised: options.advertised } : {}),
	})
	return verdict.ok
		? { ok: true, provider: providerId, tier: verdict.tier, rate: verdict.rate }
		: refuse(verdict.reason)
}

/** Why fast mode cannot run here, or `undefined` when it can. */
export async function fastModeBlocker(
	providerId: string | undefined,
	model: string | null | undefined,
	options: FastModeOptions = {},
): Promise<string | undefined> {
	const verdict = await fastModeVerdict(providerId, model, options)
	return verdict.ok ? undefined : verdict.reason
}

/**
 * The tier a `/fast` argument asks for, given the one on now; `undefined` is
 * off. `toggle` turns it on (the fast tier) when it is off, and off when either
 * tier is on.
 */
export function requestedFastTier(
	current: FastTier | undefined,
	mode: 'toggle' | 'off' | 'fast' | 'ultrafast',
): FastTier | undefined {
	if (mode === 'toggle') return current === undefined ? 'fast' : undefined
	return mode === 'off' ? undefined : mode
}

/** 2 reads `twice`; anything else reads `<n> times`. */
export function rateWords(multiplier: number): string {
	return multiplier === 2 ? 'twice' : `${multiplier} times`
}

/** What turning the mode on costs, in plain words; a number only where a source states one. */
export function fastOnMessage(verdict?: Extract<FastModeVerdict, { ok: true }>): string {
	if (verdict === undefined) {
		return 'Fast mode on: faster replies, billed at twice the standard rate. /fast off ends it.'
	}
	const { tier, rate } = verdict
	if (rate.kind === 'billing') {
		return rate.multiplier !== undefined
			? `Fast mode on: faster replies, billed at ${rateWords(rate.multiplier)} the standard rate. /fast off ends it.`
			: 'Fast mode on: faster replies, billed above the standard rate. /fast off ends it.'
	}
	if (tier === 'ultrafast') {
		return rate.multiplier !== undefined
			? `Ultrafast on: the fastest replies, using your plan allowance ${rate.multiplier}x as fast. /fast off ends it.`
			: 'Ultrafast on: the fastest replies, using much more of your plan allowance. /fast off ends it.'
	}
	return rate.multiplier !== undefined
		? `Fast mode on: faster replies, using your plan allowance ${rate.multiplier}x as fast. /fast off ends it.`
		: 'Fast mode on: faster replies, using more of your plan allowance. /fast off ends it.'
}

export function fastOffMessage(): string {
	return 'Fast mode off: standard speed and rate.'
}

/** `--fast` named a model that cannot take it; the launch continues at standard speed. */
export function fastLaunchRefusal(reason: string, source: 'flag' | 'saved' = 'flag'): string {
	const what = source === 'saved' ? 'The saved fast mode setting' : '--fast'
	return `${what} was not applied: ${reason} Continuing at standard speed.`
}

/** The model changed under fast mode and the new one cannot take it. */
export function fastDroppedMessage(reason: string): string {
	return `Fast mode turned off: ${reason}`
}

/** What the fast-mode check needs from a session besides the model. */
export interface FastSessionView {
	readonly providerId?: string
	readonly modelSummary: string | null
	readonly speedTiersFor?: (model: string) => readonly FastTier[] | undefined
	readonly reasoningSettled?: Promise<unknown>
}

/**
 * The tiers the subscription's model listing offers for the session's model.
 * The listing may still be on its way when the session opens, so a first miss
 * waits for it once.
 */
export async function fastModeOptionsFor(
	session: FastSessionView,
	tier: FastTier,
): Promise<{
	readonly tier: FastTier
	readonly advertised?: readonly FastTier[]
}> {
	const model = session.modelSummary
	if (session.providerId !== 'codex' || !model || !session.speedTiersFor) return { tier }
	let advertised = session.speedTiersFor(model)
	if (advertised === undefined && session.reasoningSettled) {
		await session.reasoningSettled
		advertised = session.speedTiersFor(model)
	}
	return { tier, ...(advertised !== undefined ? { advertised } : {}) }
}

/**
 * Applies a launch request for fast mode (`--fast`, or the saved setting) to
 * the opened session: the tier to start in, if any, and the one line to say.
 * A request the model cannot take starts at standard speed and says why.
 */
export async function launchFastOutcome(
	session: FastSessionView,
	source: 'flag' | 'saved',
): Promise<{ readonly tier: FastTier | undefined; readonly message: string }> {
	const verdict = await fastModeVerdict(
		session.providerId,
		session.modelSummary,
		await fastModeOptionsFor(session, 'fast'),
	)
	return verdict.ok
		? { tier: verdict.tier, message: fastOnMessage(verdict) }
		: { tier: undefined, message: fastLaunchRefusal(verdict.reason, source) }
}

/**
 * After a model change with `current` on: the line saying it ended, or
 * `undefined` when the new model offers the tier and the mode stays.
 */
export async function fastAfterModelChange(
	session: FastSessionView,
	current: FastTier,
): Promise<string | undefined> {
	const verdict = await fastModeVerdict(
		session.providerId,
		session.modelSummary,
		await fastModeOptionsFor(session, current),
	)
	return verdict.ok ? undefined : fastDroppedMessage(verdict.reason)
}
