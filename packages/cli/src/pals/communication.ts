/** CLI composition over SDK identity, current consent and durable session writers. */
import { randomUUID } from 'node:crypto'
import {
	lstatSync,
	mkdirSync,
	realpathSync,
	renameSync,
	unlinkSync,
	watch,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
	DiskPalActivitySubscriptionPolicy,
	DiskPalActivitySubscriptionStore,
	DiskPalCommunicationStore,
	DiskPalMessagePolicy,
	DiskSessionLog,
	type DurableInboundSource,
	type PalChannelIngressOptions,
	type PalDefinition,
	type PalIngressAuthorizationRequest,
	type PalIngressHostPort,
	type PalIngressOptions,
	type PalIngressRouteBinding,
	type PalIngressSnapshot,
	PalMessageBroker,
	type PalMessageHostPort,
	type PalRouteBinding,
	type SessionId,
	type TenantId,
	createPalIngressInboxSource,
	createPalMessagingTools,
} from '@namzu/sdk'
import { restrictToOwner } from '../integrations/providers/credential-store.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { claimPalConversation } from './conversations.js'
import { getCliPalStore } from './store.js'

export function cliPalCommunicationPolicy(home = resolveNamzuHome()) {
	return new DiskPalMessagePolicy({
		root: join(home, 'pal-message-policy'),
		secureDirectory: restrictToOwner,
	})
}

export function cliPalCommunicationStore(home = resolveNamzuHome()) {
	return new DiskPalCommunicationStore({
		root: join(home, 'pal-message-inbox'),
		secureDirectory: restrictToOwner,
	})
}

export function cliPalActivitySubscriptionStore(home = resolveNamzuHome()) {
	return new DiskPalActivitySubscriptionStore({
		root: join(home, 'pal-activity-subscriptions'),
		secureDirectory: restrictToOwner,
	})
}
export function cliPalActivitySubscriptionPolicy(home = resolveNamzuHome()) {
	return new DiskPalActivitySubscriptionPolicy({
		root: join(home, 'pal-activity-subscription-policy'),
		subscriptions: cliPalActivitySubscriptionStore(home),
		secureDirectory: restrictToOwner,
	})
}

/** Only a trusted configured connection adapter can authorize a channel actor. */
export interface CliPalIngressAuthorizationOptions {
	readonly authorizeChannel?: PalChannelIngressOptions['authorize']
	/**
	 * True only where the owner explicitly started the recipient themselves (the
	 * `namzu pal dispatch` command). A message from the owner's conversation is
	 * accepted after the tool review the owner answered, but waking its recipient is
	 * a separate consent no model-driven call can give.
	 */
	readonly operatorWake?: boolean | PalWakeConsent
}

/**
 * The owner's click in the Desktop, kept as the evidence behind a wake. The id is minted by the
 * Desktop main process for one click; it is audit text, never an authority a caller can reuse.
 */
export interface PalWakeConsent {
	readonly evidence: string
}

/** Audit reference for a message the owner approved in their own conversation; never a continuing grant. */
const OPERATOR_GRANT = { id: 'owner-conversation', revision: '1' } as const

/**
 * Authority for an owner-conversation message. It touches no disk, so a session
 * can build it without creating any Pal state.
 *
 * Security boundary: this answers `accept` for any operator-source request and
 * does not itself prove a person approved it. The approval is the tool review
 * of `send_pal_message` (`requiresApproval`, which no rule or mode outranks), so
 * the broker must only be reachable from that tool. A new caller of
 * `PalOperatorMessageBroker.send` must put its own explicit approval in front of it.
 */
export function createCliOperatorIngressAuthorization(
	options: Pick<CliPalIngressAuthorizationOptions, 'operatorWake'> = {},
): PalIngressOptions['authorize'] {
	return async (request: PalIngressAuthorizationRequest) => {
		if (!('kind' in request) || request.kind !== 'operator')
			return { allow: false, reason: 'Only an owner-conversation message is authorized here.' }
		if (request.phase === 'wake') {
			const consent = options.operatorWake
			if (consent === true) return { allow: true, grant: OPERATOR_GRANT }
			if (
				consent &&
				typeof consent === 'object' &&
				/^[A-Za-z0-9:_.-]{1,120}$/u.test(consent.evidence)
			)
				return { allow: true, grant: { id: 'owner-wake-click', revision: consent.evidence } }
			return {
				allow: false,
				reason:
					'Starting this Pal for an owner message needs your explicit go: run namzu pal dispatch.',
			}
		}
		return { allow: true, grant: OPERATOR_GRANT }
	}
}

export function createCliPalIngressAuthorization(
	input: CliPalIngressAuthorizationOptions = {},
): PalIngressOptions['authorize'] {
	const authorizeChannel = input.authorizeChannel
	const peer = cliPalCommunicationPolicy()
	const observation = cliPalActivitySubscriptionPolicy()
	const operator = createCliOperatorIngressAuthorization(input)
	return async (request: PalIngressAuthorizationRequest) => {
		if (!('kind' in request)) return peer.authorize(request)
		if (request.kind === 'operator') return operator(request)
		if (request.kind === 'observation') return observation.authorizeIngress(request)
		if (!authorizeChannel)
			return { allow: false, reason: 'No trusted channel authorization adapter is configured.' }
		return authorizeChannel(request)
	}
}

function wakeDirectory(palId: string): string {
	if (!getCliPalStore().get(palId)) throw new Error('Unknown Pal notification recipient.')
	const root = join(resolveNamzuHome(), 'pal-message-wake')
	const directory = join(root, palId)
	for (const path of [root, directory]) {
		mkdirSync(path, { recursive: true, mode: 0o700 })
		if (
			!lstatSync(path).isDirectory() ||
			lstatSync(path).isSymbolicLink() ||
			realpathSync(path) !== path
		)
			throw new Error('Pal notification directories must be real and have no aliases.')
		restrictToOwner(path)
	}
	return directory
}

/** Notification files are hints only; the SDK inbox remains authoritative. */
export function createCliPalIngressHost(
	runConversation?: PalIngressHostPort['runConversation'],
): PalIngressHostPort {
	const pals = getCliPalStore()
	return {
		async ensureConversation(binding, signal) {
			signal.throwIfAborted()
			const definition = pals.getRevision(binding.key.recipient.palId, binding.profileRevision)
			const state = await openSessions(definition.workspace)
			try {
				if (state.tenantId !== binding.key.recipient.tenantId)
					throw new Error('Foreign Pal conversation tenant.')
			} finally {
				closeSessions(state)
			}
			await claimPalConversation(
				definition.workspace,
				definition.id,
				binding.sessionId,
				binding.profileRevision,
			)
			signal.throwIfAborted()
		},
		async openConversation(binding, signal) {
			signal.throwIfAborted()
			const definition = pals.getRevision(binding.key.recipient.palId, binding.profileRevision)
			const state = await openSessions(definition.workspace)
			try {
				if (state.tenantId !== binding.key.recipient.tenantId)
					throw new Error('Foreign Pal conversation tenant.')
				return {
					projectId: state.projectId,
					log: DiskSessionLog.at(state.paths, { sessionId: binding.sessionId }),
				}
			} finally {
				closeSessions(state)
			}
		},
		notify(recipient) {
			const directory = wakeDirectory(recipient.palId)
			const temporary = join(directory, `${randomUUID()}.tmp`)
			let failure: unknown
			try {
				writeFileSync(temporary, randomUUID(), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
				renameSync(temporary, join(directory, 'signal'))
			} catch (error) {
				failure = error
			}
			try {
				unlinkSync(temporary)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
					failure = failure
						? new AggregateError([failure, error], 'Pal notification and cleanup failed.')
						: error
			}
			if (failure) throw failure
		},
		async runConversation(binding, source, signal) {
			if (!runConversation) throw new Error('This host has no explicit Pal message dispatcher.')
			await runConversation(binding, source, signal)
		},
	}
}

/** Existing Pal-only host signature remains available to peer brokers. */
export function createCliPalMessageHost(
	runConversation?: PalMessageHostPort['runConversation'],
): PalMessageHostPort {
	return createCliPalIngressHost(
		runConversation
			? async (binding, source, signal) => {
					if (binding.key.kind !== 'pal')
						throw new Error('This Pal-only host cannot run another input family.')
					await runConversation(binding as PalRouteBinding, source, signal)
				}
			: undefined,
	)
}

export function createCliPalMessagingContext(
	profile: PalDefinition,
	contextScope: { readonly sessionId: SessionId; readonly tenantId: TenantId },
	assertActive: () => void,
	options: CliPalIngressAuthorizationOptions = {},
) {
	const definition = Object.freeze({
		...profile,
		model: profile.model ? Object.freeze({ ...profile.model }) : null,
		...(profile.appearance ? { appearance: Object.freeze({ ...profile.appearance }) } : {}),
	})
	const scope = Object.freeze({ ...contextScope })
	const pals = getCliPalStore()
	const store = cliPalCommunicationStore()
	const policy = cliPalCommunicationPolicy()
	const host = createCliPalIngressHost()
	const authorizePeer = policy.authorize.bind(policy)
	const authorize = createCliPalIngressAuthorization(options)
	const source = {
		address: { tenantId: scope.tenantId, palId: definition.id },
		conversationId: scope.sessionId,
		profileRevision: definition.revision,
	}
	const broker = new PalMessageBroker({ pals, store, host, authorize: authorizePeer })
	const tools = createPalMessagingTools({
		source,
		sender: broker.sender(source),
		assertCurrentAdmission: () => assertActive(),
		async listAuthorizedPals() {
			const rules = await policy.outgoing(source.address)
			return rules.flatMap((rule) => {
				const pal = pals.get(rule.recipient.palId)
				return pal ? [{ palId: pal.id, name: pal.name }] : []
			})
		},
	})
	const inbox = (binding: PalIngressRouteBinding) =>
		createPalIngressInboxSource({ pals, store, host, authorize, binding })
	const ownBinding = (binding: PalIngressRouteBinding | undefined): PalIngressRouteBinding => {
		if (
			!binding ||
			binding.sessionId !== scope.sessionId ||
			binding.profileRevision !== definition.revision ||
			binding.key.recipient.palId !== definition.id ||
			binding.key.recipient.tenantId !== scope.tenantId
		)
			throw new Error('Foreign Pal conversation inbox route.')
		return binding
	}
	const belongsHere = (state: PalIngressSnapshot, routeId: string) =>
		state.routes.find((route) => route.id === routeId)?.sessionId === scope.sessionId
	const pendingHere = (state: PalIngressSnapshot) =>
		state.messages.some(
			(message) => message.phase === 'pending' && belongsHere(state, message.routeId),
		)
	const assertNoBlockedDelivery = (state: PalIngressSnapshot | null) => {
		const unresolved = state?.messages.find((message) => message.phase === 'claimed')
		if (state && unresolved && (belongsHere(state, unresolved.routeId) || pendingHere(state)))
			throw new Error(
				'Unfinished Pal delivery requires reconciliation before continuing this conversation.',
			)
	}
	const durableInbound: DurableInboundSource = {
		async claim(context) {
			if (context.sessionId !== scope.sessionId)
				throw new Error('Foreign query cannot drain this Pal conversation.')
			context.signal.throwIfAborted()
			assertActive()
			const state = await store.readIngress(source.address)
			const claimed = state?.messages.find((message) => message.phase === 'claimed')
			const next =
				claimed ??
				state?.messages.find(
					(message) =>
						message.phase === 'pending' &&
						state.routes.find((route) => route.id === message.routeId)?.sessionId ===
							scope.sessionId,
				)
			if (!next) return []
			let binding = state?.routes.find((route) => route.id === next.routeId)
			if (binding?.sessionId !== scope.sessionId) {
				assertNoBlockedDelivery(state)
				return []
			}
			binding = ownBinding(binding)
			if (binding.phase === 'reserved') {
				await host.ensureConversation(binding, context.signal)
				assertActive()
				binding = await store.activateIngress(binding, {
					binding,
					definition,
					access: await host.openConversation(binding, context.signal),
				})
			}
			const claims = await inbox(binding).claim(context)
			assertActive()
			if (!claims.length) assertNoBlockedDelivery(await store.readIngress(source.address))
			return claims
		},
		async recorded(receipts) {
			for (const receipt of receipts) {
				const state = await store.readIngress(source.address)
				const message = state?.messages.find((item) => item.id === receipt.ref.id)
				const binding = ownBinding(state?.routes.find((item) => item.id === message?.routeId))
				await inbox(binding).recorded([receipt])
			}
		},
		async wait(signal) {
			signal.throwIfAborted()
			const directory = wakeDirectory(definition.id)
			// Register first, then inspect authoritative state to cover lost hints.
			await new Promise<void>((resolve, reject) => {
				let settled = false
				const cleanup = () => {
					watcher.close()
					signal.removeEventListener('abort', onAbort)
				}
				const finish = (error?: unknown) => {
					if (settled) return
					settled = true
					cleanup()
					if (error !== undefined) reject(error)
					else resolve()
				}
				const check = () => {
					if (settled) return
					store.readIngress(source.address).then((state) => {
						if (settled) return
						try {
							assertNoBlockedDelivery(state)
							if (state && pendingHere(state)) finish()
						} catch (error) {
							finish(error)
						}
					}, finish)
				}
				const watcher = watch(directory, { persistent: false }, check)
				const onAbort = () => finish(signal.reason ?? new Error('Pal inbox wait aborted.'))
				watcher.on('error', finish)
				signal.addEventListener('abort', onAbort, { once: true })
				if (signal.aborted) onAbort()
				else check()
			})
		},
	}
	return { tools, durableInbound }
}
