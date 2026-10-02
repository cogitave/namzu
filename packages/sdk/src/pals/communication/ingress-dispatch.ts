import { createPalIngressInboxSource, reconcilePalIngressDelivery } from './ingress-inbound.js'
import {
	type PalIngressDispatchOutcome,
	type PalIngressOptions,
	currentIngressRecipient,
	ingressAuthorizationRequest,
} from './ingress-types.js'
import type { PalAddress } from './types.js'
import { verifyIngressConversation } from './verify.js'

/** Finite opt-in operation; host retains normal query/computer ownership. */
export async function dispatchPalIngressOnce(
	options: PalIngressOptions,
	recipient: PalAddress,
	signal: AbortSignal,
): Promise<PalIngressDispatchOutcome> {
	signal.throwIfAborted()
	const host = options.host
	if (!host)
		return {
			status: 'blocked',
			reason: 'No Pal conversation host is configured.',
		}
	let state = await options.store.readIngress(recipient)
	const unresolved = state?.messages.find((m) => m.phase === 'claimed')
	if (unresolved) {
		const binding = state?.routes.find((r) => r.id === unresolved.routeId)
		if (
			!binding ||
			!(await reconcilePalIngressDelivery({ ...options, binding, host }, unresolved, signal))
		)
			return { status: 'idle', reason: 'unresolved' }
		state = await options.store.readIngress(recipient)
	}
	const message = state?.messages.find((m) => m.phase === 'pending')
	if (!message) return { status: 'idle', reason: 'empty' }
	let binding = state?.routes.find((r) => r.id === message.routeId)
	if (!binding) throw new Error('Pal incoming message has no route binding.')
	const authorization = await options.authorize(ingressAuthorizationRequest(message, 'wake'))
	if (!authorization.allow) return { status: 'blocked', reason: authorization.reason }
	currentIngressRecipient(options.pals, binding)
	signal.throwIfAborted()
	await host.ensureConversation(binding, signal)
	const definition = currentIngressRecipient(options.pals, binding)
	const access = await host.openConversation(binding, signal)
	await verifyIngressConversation({ binding, access, definition })
	if (binding.phase === 'reserved')
		binding = await options.store.activateIngress(binding, {
			binding,
			access,
			definition,
		})
	const currentAuthorization = await options.authorize(ingressAuthorizationRequest(message, 'wake'))
	if (!currentAuthorization.allow) return { status: 'blocked', reason: currentAuthorization.reason }
	currentIngressRecipient(options.pals, binding)
	signal.throwIfAborted()
	await host.runConversation(
		binding,
		createPalIngressInboxSource({ ...options, binding, host }),
		signal,
	)
	return { status: 'ran', binding }
}
