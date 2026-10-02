import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { ingressIntentDigest, ingressIntentId } from '../communication/ingress-schema.js'
import type { PalIngressStore, PalObservationIntent } from '../communication/ingress-types.js'
import { freezeCommunicationValue, hash, label } from '../communication/schema.js'
import type { PalMessageAuthorization, PalMessageGrant } from '../communication/types.js'
import type { PalStore } from '../types.js'
import { createPalActivitySource } from './source.js'
import { subscriptionSchema } from './subscription-schema.js'
import type {
	PalActivitySubscriptionAuthorizationRequest,
	PalActivitySubscriptionResult,
	PalActivitySubscriptionStore,
} from './subscription-types.js'
import type {
	PalActivityFact,
	PalActivityReadOptions,
	PalActivityScope,
	PalActivitySourceOptions,
} from './types.js'

export class PalActivitySubscriptionDeniedError extends Error {
	override readonly name = 'PalActivitySubscriptionDeniedError'
	constructor() {
		super('Current Pal observation, disclosure and recipient consent are required.')
	}
}

export interface PalActivitySubscriptionRunnerOptions {
	readonly subscriptions: PalActivitySubscriptionStore
	readonly ingress: PalIngressStore
	readonly pals: PalStore
	readonly openJournal: PalActivitySourceOptions['openJournal']
	/**
	 * Trusted current host policy. Observation, disclosure and receipt are independent decisions;
	 * the final `accept` phase must require all three together under current consent.
	 */
	readonly authorize: (
		request: PalActivitySubscriptionAuthorizationRequest,
		signal: AbortSignal,
	) => Promise<PalMessageAuthorization>
	/**
	 * Resolve prior subscription IDs from original turn delivery evidence retained by the host.
	 * An independent turn yields []; unknown or incomplete evidence must reject. Never accept
	 * a model, renderer or remote client's assertion about its own provenance.
	 */
	readonly resolveCausality: (
		scope: PalActivityScope,
		fact: PalActivityFact,
		signal: AbortSignal,
	) => Promise<readonly string[]>
	readonly now?: () => number
	/** Hint only. Observer failures and pending promises cannot prevent acceptance/progress. */
	readonly notify?: (palId: string) => void | Promise<void>
}

/** One bounded page, no daemon and no inference. Progress follows durable inbox acceptance. */
export async function publishPalActivityOnce(
	options: PalActivitySubscriptionRunnerOptions,
	id: string,
	input: Omit<PalActivityReadOptions, 'cursor'>,
): Promise<PalActivitySubscriptionResult> {
	const subscriptionId = z.string().uuid().parse(id)
	const { signal } = input
	const { subscriptions, ingress, pals, openJournal, authorize, resolveCausality, notify } = options
	const now = options.now ?? Date.now
	if (
		typeof authorize !== 'function' ||
		typeof resolveCausality !== 'function' ||
		typeof openJournal !== 'function'
	)
		throw new TypeError(
			'Pal subscriptions require trusted policy, causality and original journal ports.',
		)
	signal.throwIfAborted()
	const stored = await subscriptions.get(subscriptionId)
	if (!stored) throw new PalActivitySubscriptionDeniedError()
	const subscription = freezeCommunicationValue(subscriptionSchema.parse(stored))
	async function current() {
		signal.throwIfAborted()
		const value = await subscriptions.get(subscriptionId)
		signal.throwIfAborted()
		if (
			!value?.enabled ||
			value.configurationRevision !== subscription.configurationRevision ||
			!isDeepStrictEqual(value.scope, subscription.scope) ||
			!isDeepStrictEqual(value.recipient, subscription.recipient)
		)
			throw new PalActivitySubscriptionDeniedError()
	}
	async function permitted(
		phase: PalActivitySubscriptionAuthorizationRequest['phase'],
		fact?: PalActivityFact,
	): Promise<PalMessageGrant> {
		await current()
		const decision = await authorize(
			freezeCommunicationValue({
				phase,
				subscription,
				...(fact ? { fact } : {}),
			}),
			signal,
		)
		signal.throwIfAborted()
		if (!decision.allow) throw new PalActivitySubscriptionDeniedError()
		const grant = freezeCommunicationValue(
			z.object({ id: label, revision: label }).strict().parse(decision.grant),
		)
		await current()
		return grant
	}
	const source = createPalActivitySource({
		scope: subscription.scope,
		pals,
		openJournal,
		async authorize() {
			await permitted('observe')
			return true
		},
	})
	const page = await source.read({
		signal,
		maxRecords: input.maxRecords,
		maxReadBytes: input.maxReadBytes,
		...(subscription.cursor ? { cursor: subscription.cursor } : {}),
	})
	const accepted: string[] = []
	const suppressed: string[] = []
	for (const fact of page.facts) {
		const observed = await permitted('observe', fact)
		const lineage = z
			.array(z.string().uuid())
			.refine((ids) => new Set(ids).size === ids.length)
			.parse(await resolveCausality(subscription.scope, fact, signal))
		signal.throwIfAborted()
		await current()
		if (lineage.includes(subscription.id)) {
			suppressed.push(fact.id)
			continue
		}
		const disclosed = await permitted('disclose', fact)
		const received = await permitted('receive', fact)
		const recipient = pals.get(subscription.recipient.palId)
		if (!recipient) throw new PalActivitySubscriptionDeniedError()
		const acceptedGrant = await permitted('accept', fact)
		const draft = {
			kind: 'observation' as const,
			operationId: fact.id,
			source: {
				kind: 'host-observation' as const,
				subscriptionId: subscription.id,
				scope: subscription.scope,
			},
			recipient: subscription.recipient,
			routeKey: {
				v: 1 as const,
				kind: 'observation' as const,
				recipient: subscription.recipient,
				subscriptionId: subscription.id,
				scope: subscription.scope,
			},
			fact,
			subscriptionTrail: [...lineage, subscription.id],
			replyTo: null,
			grant: {
				id: hash([
					'pal-observation-grants/1',
					subscription.id,
					observed.id,
					disclosed.id,
					received.id,
					acceptedGrant.id,
				]),
				revision: hash([
					subscription.configurationRevision,
					observed.revision,
					disclosed.revision,
					received.revision,
					acceptedGrant.revision,
				]),
			},
			createdAt: now(),
		}
		const intentId = ingressIntentId(draft)
		const intent = freezeCommunicationValue({
			...draft,
			id: intentId,
			digest: ingressIntentDigest({ ...draft, id: intentId }),
		}) as PalObservationIntent
		await ingress.acceptIngress(intent, recipient.revision)
		accepted.push(intent.id)
		if (notify) {
			try {
				Promise.resolve(notify(subscription.recipient.palId)).catch(() => {})
			} catch {}
		}
	}
	await permitted('observe')
	const next =
		subscription.cursor && isDeepStrictEqual(subscription.cursor, page.cursor)
			? subscription
			: await subscriptions.advance(subscription, page.cursor)
	return freezeCommunicationValue({
		subscription: next,
		accepted,
		suppressed,
		complete: page.complete,
	})
}
