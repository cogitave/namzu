/** Metadata-only native operator actions over the existing host-owned Pal stores. */
import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import {
	DiskLogMedium,
	DiskSessionLog,
	type PalActivityScope,
	type PalActivitySubscription,
	PalActivitySubscriptionConflictError,
	type PalActivitySubscriptionPermission,
	type PalDefinition,
	type PalMessagePermission,
	PalMessagePermissionConflictError,
	asSessionId,
	createPalActivitySource,
	isEntityId,
} from '@namzu/sdk'
import {
	type CliSessions,
	closeSessions,
	openSessions,
	readConversationFacts,
} from '../integrations/sessions/store.js'
import { isTrustedAtStateRoot } from '../integrations/trust/store.js'
import {
	cliPalActivitySubscriptionPolicy,
	cliPalActivitySubscriptionStore,
	cliPalCommunicationPolicy,
	cliPalCommunicationStore,
} from './communication.js'
import { palConversationBinding } from './conversations.js'
import { cliPalStore, palAtWorkspace } from './store.js'

export interface DesktopPalPermission {
	readonly revision: number
	readonly enabled: boolean
	readonly allowWake: boolean
}
export interface DesktopPalSubscription {
	readonly v: 1
	readonly id: string
	readonly revision: number
	readonly configurationRevision: number
	readonly sourcePalId: string
	readonly sourceConversationId: string
	readonly sourceProfileRevision: number
	readonly recipientPalId: string
	readonly enabled: boolean
	readonly permission: {
		readonly revision: number
		readonly observe: boolean
		readonly disclose: boolean
		readonly receive: boolean
		readonly wake: boolean
	} | null
	readonly progress: { readonly lastSequence: number | null }
}

class RequestError extends Error {}
const UNAVAILABLE = 'Pal communication unavailable; its records could not be read completely.'
const UNCONFIRMED = 'Pal communication change could not be confirmed. Reload before trying again.'
function exact(params: Record<string, unknown>, fields: readonly string[]) {
	if (Object.keys(params).some((key) => !fields.includes(key)))
		throw new RequestError('Unexpected Pal communication fields.')
}
function id(params: Record<string, unknown>, field: string): string {
	const value = params[field]
	if (typeof value !== 'string' || !isEntityId(value, 'session'))
		throw new RequestError(`Invalid ${field}.`)
	return value
}
function revision(params: Record<string, unknown>) {
	const value = params.expectedRevision
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new RequestError('An exact nonnegative expected revision is required.')
	return value
}
function boolean(params: Record<string, unknown>, field: string) {
	const value = params[field]
	if (typeof value !== 'boolean') throw new RequestError(`Explicit ${field} is required.`)
	return value
}
function permission(value: PalMessagePermission | null): DesktopPalPermission {
	return {
		revision: value?.revision ?? 0,
		enabled: value?.enabled ?? false,
		allowWake: Boolean(value?.enabled && value.allowWake),
	}
}
function subscription(
	value: PalActivitySubscription,
	consent: PalActivitySubscriptionPermission | null,
): DesktopPalSubscription {
	return {
		v: 1,
		id: value.id,
		revision: value.revision,
		configurationRevision: value.configurationRevision,
		sourcePalId: value.scope.palId,
		sourceConversationId: value.scope.sessionId,
		sourceProfileRevision: value.scope.profileRevision,
		recipientPalId: value.recipient.palId,
		enabled: value.enabled,
		permission: consent
			? {
					revision: consent.revision,
					observe: consent.observe,
					disclose: consent.disclose,
					receive: consent.receive,
					wake: consent.wake,
				}
			: null,
		progress: { lastSequence: value.cursor?.after.seq ?? null },
	}
}
function directoryIdentity(path: string) {
	const stat = lstatSync(path, { bigint: true })
	if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
		throw new RequestError('The Pal application home changed; reload before continuing.')
	return `${stat.dev}/${stat.ino}/${stat.birthtimeNs}`
}
function title(value: string | undefined) {
	return (
		[...(value ?? '')]
			.slice(0, 200)
			.map((character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character,
			)
			.join('')
			.trim() || 'New conversation'
	)
}

export function createDesktopPalCommunicationExtensions(options: {
	readonly cwd: string
	readonly withState: <T>(run: (state: CliSessions) => Promise<T>) => Promise<T>
}) {
	// A desktop snapshot is scoped to this connection, including its physical home.
	// Replacing a home with copied IDs/revisions requires a new authenticated client.
	let homeScope: { readonly root: string; readonly identity: string } | undefined
	const within = async <T>(
		params: Record<string, unknown>,
		fields: readonly string[],
		mutation: boolean,
		run: (
			context: {
				state: CliSessions
				pal: PalDefinition
				assertCurrent: () => void
				peer: (palId: string) => PalDefinition
				assertPeer: (pal: PalDefinition) => void
			},
			input: Readonly<Record<string, unknown>>,
		) => Promise<T>,
	): Promise<T> => {
		try {
			const input = Object.freeze({ ...params })
			exact(input, fields)
			const palId = id(input, 'palId')
			if (homeScope && directoryIdentity(homeScope.root) !== homeScope.identity)
				throw new RequestError('The Pal application home changed; reconnect before continuing.')
			return await options.withState(async (state) => {
				const homeIdentity = directoryIdentity(state.root)
				if (homeScope && (homeScope.root !== state.root || homeScope.identity !== homeIdentity))
					throw new RequestError('The Pal application home changed; reconnect before continuing.')
				const pal = palAtWorkspace(options.cwd, state.root)
				if (!pal || pal.id !== palId || pal.workspace !== state.projectRoot)
					throw new RequestError('This Pal does not own the current workspace.')
				const assertCurrent = () => {
					if (
						directoryIdentity(state.root) !== homeIdentity ||
						!isTrustedAtStateRoot(options.cwd, state.root)
					)
						throw new RequestError('The Pal context changed; reload before continuing.')
					const current = palAtWorkspace(options.cwd, state.root)
					if (
						current?.id !== pal.id ||
						current.workspace !== pal.workspace ||
						current.revision !== pal.revision
					)
						throw new RequestError('The Pal context changed; reload before continuing.')
				}
				const peer = (peerId: string) => {
					assertCurrent()
					const found = cliPalStore(state.root).get(peerId)
					if (!found || palAtWorkspace(found.workspace, state.root)?.id !== found.id)
						throw new RequestError('The selected Pal is unavailable in this application home.')
					return found
				}
				const assertPeer = (captured: PalDefinition) => {
					const current = peer(captured.id)
					if (current.workspace !== captured.workspace || current.revision !== captured.revision)
						throw new RequestError('The selected Pal changed; reload before continuing.')
				}
				assertCurrent()
				homeScope ??= { root: state.root, identity: homeIdentity }
				const result = await run({ state, pal, assertCurrent, peer, assertPeer }, input)
				assertCurrent()
				return result
			})
		} catch (error) {
			if (error instanceof RequestError) throw error
			if (
				error instanceof PalMessagePermissionConflictError ||
				error instanceof PalActivitySubscriptionConflictError
			)
				throw new RequestError('Pal consent changed; reload before applying this change.')
			throw new Error(mutation ? UNCONFIRMED : UNAVAILABLE)
		}
	}
	return {
		'namzu/pals/communication/peers': (params: Record<string, unknown>) =>
			within(params, ['palId'], false, async ({ state, pal, assertPeer, peer }) => {
				const policy = cliPalCommunicationPolicy(state.root)
				const own = { tenantId: state.tenantId, palId: pal.id }
				const peers = []
				for (const entry of cliPalStore(state.root).list()) {
					if (entry.id === pal.id) continue
					const other = peer(entry.id)
					const address = { tenantId: state.tenantId, palId: other.id }
					const outgoing = permission(await policy.get(own, address))
					const incoming = permission(await policy.get(address, own))
					assertPeer(other)
					peers.push({
						palId: other.id,
						name: other.name,
						paused: other.paused,
						outgoing,
						incoming,
					})
				}
				return { v: 1 as const, palId: pal.id, peers }
			}),
		'namzu/pals/communication/inbox': (params: Record<string, unknown>) =>
			within(params, ['palId'], false, async ({ state, pal }) => {
				const snapshot = await cliPalCommunicationStore(state.root).readIngress({
					tenantId: state.tenantId,
					palId: pal.id,
				})
				const messages = (snapshot?.messages ?? []).map((message) => ({
					id: message.id,
					status: message.phase,
					conversationId: snapshot?.routes.find((route) => route.id === message.routeId)?.sessionId,
					...(!('kind' in message)
						? { sourceKind: 'pal' as const, sourcePalId: message.source.address.palId }
						: message.kind === 'observation'
							? {
									sourceKind: 'host-observation' as const,
									subscriptionId: message.source.subscriptionId,
									observedPalId: message.source.scope.palId,
								}
							: message.kind === 'operator'
								? {
										sourceKind: 'operator-conversation' as const,
										operatorSessionId: message.source.sessionId,
									}
								: {
										sourceKind: 'channel' as const,
										provider: message.source.provider,
										connectionId: message.source.connectionId,
										actorId: message.source.actorId,
									}),
				}))
				return { v: 1 as const, palId: pal.id, messages }
			}),
		'namzu/pals/communication/permissions/update': (params: Record<string, unknown>) =>
			within(
				params,
				['palId', 'peerPalId', 'expectedRevision', 'enabled', 'allowWake'],
				true,
				async ({ state, pal, peer, assertPeer }, input) => {
					const other = peer(id(input, 'peerPalId'))
					const expectedRevision = revision(input)
					const enabled = boolean(input, 'enabled')
					const allowWake = boolean(input, 'allowWake')
					if (!enabled && allowWake)
						throw new RequestError('Wake permission requires enabled communication.')
					const policy = cliPalCommunicationPolicy(state.root)
					assertPeer(other)
					const updated = await policy.update({
						source: { tenantId: state.tenantId, palId: pal.id },
						recipient: { tenantId: state.tenantId, palId: other.id },
						expectedRevision,
						enabled,
						allowWake,
					})
					return {
						v: 1 as const,
						palId: pal.id,
						peerPalId: other.id,
						permission: permission(updated),
					}
				},
			),
		'namzu/pals/communication/subscriptions/list': (params: Record<string, unknown>) =>
			within(params, ['palId'], false, async ({ state, pal, peer, assertPeer, assertCurrent }) => {
				const stored = await cliPalActivitySubscriptionStore(state.root).list()
				const policy = cliPalActivitySubscriptionPolicy(state.root)
				const subscriptions: DesktopPalSubscription[] = []
				for (const value of stored) {
					if (
						value.scope.tenantId !== state.tenantId ||
						(value.scope.palId !== pal.id && value.recipient.palId !== pal.id)
					)
						continue
					subscriptions.push(subscription(value, await policy.get(value.id)))
				}
				const sources = []
				for (const entry of cliPalStore(state.root).list()) {
					const source = peer(entry.id)
					const sourceState =
						source.id === pal.id
							? state
							: await openSessions(source.workspace, { stateRoot: state.root })
					try {
						assertPeer(source)
						if (
							sourceState.tenantId !== state.tenantId ||
							sourceState.projectRoot !== source.workspace
						)
							throw new RequestError('Foreign Pal activity source.')
						const candidates = await sourceState.index.listSessions({
							slug: sourceState.slug,
							rootsOnly: true,
							includeArchived: false,
						})
						const conversations = []
						for (const row of candidates) {
							if (row.projectId !== sourceState.projectId) continue
							const facts = await readConversationFacts(sourceState, row.id)
							if (!facts) throw new Error('An indexed source journal is unavailable.')
							if (facts.archived || facts.started.origin?.protocol !== 'desktop') continue
							const origin = facts.started.origin.externalSessionId
							if (typeof origin !== 'string') continue
							let marker: unknown
							try {
								marker = JSON.parse(origin)
							} catch {
								if (origin.includes('namzu-pal')) throw new Error('Invalid source origin.')
								continue
							}
							if (!Array.isArray(marker) || marker[0] !== 'namzu-pal') continue
							const binding = await palConversationBinding(source.workspace, row.id, sourceState)
							if (!binding || binding.pal.id !== source.id)
								throw new Error('Invalid source binding.')
							conversations.push({
								id: row.id,
								title: title(facts.named ? facts.title : undefined),
								profileRevision: binding.definition.revision,
							})
						}
						assertPeer(source)
						sources.push({ palId: source.id, name: source.name, conversations })
					} finally {
						if (sourceState !== state) closeSessions(sourceState)
					}
				}
				assertCurrent()
				return { v: 1 as const, palId: pal.id, subscriptions, sources }
			}),
		'namzu/pals/communication/subscriptions/create': (params: Record<string, unknown>) =>
			within(
				params,
				['palId', 'sourcePalId', 'sourceSessionId', 'recipientPalId', 'wake'],
				true,
				async ({ state, pal, peer, assertPeer, assertCurrent }, input) => {
					const source = peer(id(input, 'sourcePalId'))
					const recipient = peer(id(input, 'recipientPalId'))
					const sourceSessionId = id(input, 'sourceSessionId')
					const wake = boolean(input, 'wake')
					if (source.id !== pal.id && recipient.id !== pal.id)
						throw new RequestError('This Pal is not a participant in the activity subscription.')
					const sourceState =
						source.id === pal.id
							? state
							: await openSessions(source.workspace, { stateRoot: state.root })
					let scope: PalActivityScope
					let log: DiskSessionLog
					try {
						assertPeer(source)
						if (
							sourceState.tenantId !== state.tenantId ||
							sourceState.projectRoot !== source.workspace
						)
							throw new RequestError('Foreign Pal activity source.')
						const binding = await palConversationBinding(
							source.workspace,
							sourceSessionId,
							sourceState,
						)
						if (!binding || binding.pal.id !== source.id)
							throw new RequestError('Activity requires the selected Pal’s original conversation.')
						scope = {
							tenantId: state.tenantId,
							projectId: sourceState.projectId,
							palId: source.id,
							profileRevision: binding.definition.revision,
							sessionId: asSessionId(sourceSessionId),
						}
						log = DiskSessionLog.at(sourceState.paths, { sessionId: scope.sessionId })
						await createPalActivitySource({
							scope,
							pals: cliPalStore(state.root),
							openJournal: async () => ({ log, bytes: new DiskLogMedium(log.file) }),
							authorize: async () => {
								assertCurrent()
								assertPeer(source)
								assertPeer(recipient)
								return true
							},
						}).read({
							signal: new AbortController().signal,
							maxRecords: 1,
							maxReadBytes: 1024 * 1024,
						})
					} finally {
						if (sourceState !== state) closeSessions(sourceState)
					}
					assertPeer(source)
					assertPeer(recipient)
					const subscriptions = cliPalActivitySubscriptionStore(state.root)
					const pending = await subscriptions.create({
						id: randomUUID(),
						scope,
						recipient: { tenantId: state.tenantId, palId: recipient.id },
						enabled: false,
					})
					assertPeer(source)
					assertPeer(recipient)
					const policy = cliPalActivitySubscriptionPolicy(state.root)
					const consent = await policy.update({
						subscriptionId: pending.id,
						expectedRevision: 0,
						observe: true,
						disclose: true,
						receive: true,
						wake,
					})
					assertPeer(source)
					assertPeer(recipient)
					const enabled = await subscriptions.setEnabled({
						id: pending.id,
						expectedRevision: pending.revision,
						enabled: true,
					})
					return { v: 1 as const, palId: pal.id, subscription: subscription(enabled, consent) }
				},
			),
		'namzu/pals/communication/subscriptions/disable': (params: Record<string, unknown>) =>
			within(
				params,
				['palId', 'id', 'expectedRevision'],
				true,
				async ({ state, pal, assertCurrent }, input) => {
					const subscriptionId = id(input, 'id')
					const expectedRevision = revision(input)
					const subscriptions = cliPalActivitySubscriptionStore(state.root)
					const prior = await subscriptions.get(subscriptionId)
					if (
						!prior ||
						prior.scope.tenantId !== state.tenantId ||
						(prior.scope.palId !== pal.id && prior.recipient.palId !== pal.id)
					)
						throw new RequestError('This Pal does not own the selected activity subscription.')
					const consent = await cliPalActivitySubscriptionPolicy(state.root).get(prior.id)
					assertCurrent()
					const updated = await subscriptions.setEnabled({
						id: prior.id,
						expectedRevision,
						enabled: false,
					})
					return { v: 1 as const, palId: pal.id, subscription: subscription(updated, consent) }
				},
			),
	}
}
