import { randomUUID } from 'node:crypto'
import type {
	PalCommunicationView,
	PalPermissionChange,
	PalSubscriptionCreate,
	PalSubscriptionDisable,
} from '../shared/pal-communication-protocol.js'
import {
	readPalInbox,
	readPalPeers,
	readPalPermissionResult,
	readPalSubscriptionResult,
	readPalSubscriptions,
} from '../shared/pal-communication-protocol.js'
import type { DesktopDiagnosticSink } from './diagnostics.js'

export const PAL_COMMUNICATION_METHODS = [
	'namzu/pals/communication/peers',
	'namzu/pals/communication/inbox',
	'namzu/pals/communication/permissions/update',
	'namzu/pals/communication/subscriptions/list',
	'namzu/pals/communication/subscriptions/create',
	'namzu/pals/communication/subscriptions/disable',
] as const

export interface PalCommunicationScope {
	client: {
		supportsPalCommunication(): boolean
		request(method: string, params?: unknown): Promise<unknown>
	}
	runtimeSessionId: string
	assertCurrent(): void
}
type Captured = { scope: PalCommunicationScope; view: PalCommunicationView }

/** Metadata management uses the existing claimed client, never a finite dispatcher. */
export class PalCommunicationManager {
	private snapshots = new Map<string, Captured>()
	private reads = new Map<string, symbol>()
	private mutations = new Set<string>()
	constructor(
		private readonly capture: (sessionId: string, palId: string) => PalCommunicationScope,
		private readonly diagnostics?: DesktopDiagnosticSink,
	) {}
	private key(sessionId: string, palId: string): string {
		if (typeof sessionId !== 'string' || typeof palId !== 'string' || !sessionId || !palId)
			throw new Error('Open this Pal conversation first.')
		return JSON.stringify([sessionId, palId])
	}
	async read(sessionId: string, palId: string, settling = false): Promise<PalCommunicationView> {
		const key = this.key(sessionId, palId)
		if (!settling && this.mutations.has(palId))
			throw new Error('Wait for this Pal’s communication change to finish.')
		const scope = this.capture(sessionId, palId)
		scope.assertCurrent()
		const previous = this.snapshots.get(key)
		const retained =
			previous?.scope.client === scope.client &&
			previous.scope.runtimeSessionId === scope.runtimeSessionId
				? previous.view
				: undefined
		const owner = Symbol('Pal communication read')
		this.reads.set(key, owner)
		const current = () => {
			scope.assertCurrent()
			if (this.reads.get(key) !== owner)
				throw new Error('Pal communication changed; refresh this view.')
		}
		const supported = scope.client.supportsPalCommunication()
		const view: PalCommunicationView = {
			palId,
			snapshotId: randomUUID(),
			supported,
			peers: retained?.peers ?? [],
			messages: retained?.messages ?? [],
			subscriptions: retained?.subscriptions ?? [],
			sources: retained?.sources ?? [],
		}
		if (!supported) {
			const notice =
				'This runtime does not support Pal communication management. Update the CLI to use it.'
			view.peersNotice = notice
			view.inboxNotice = notice
			view.subscriptionsNotice = notice
		} else {
			const sections = [
				{
					method: PAL_COMMUNICATION_METHODS[0],
					notice: 'peersNotice' as const,
					apply: (value: unknown) => {
						view.peers = readPalPeers(value, palId)
					},
				},
				{
					method: PAL_COMMUNICATION_METHODS[1],
					notice: 'inboxNotice' as const,
					apply: (value: unknown) => {
						view.messages = readPalInbox(value, palId)
					},
				},
				{
					method: PAL_COMMUNICATION_METHODS[3],
					notice: 'subscriptionsNotice' as const,
					apply: (value: unknown) => {
						Object.assign(view, readPalSubscriptions(value, palId))
					},
				},
			]
			await Promise.all(
				sections.map(async (section) => {
					try {
						const value = await scope.client.request(section.method, { palId })
						current()
						section.apply(value)
					} catch {
						current()
						view[section.notice] =
							'Unavailable. Previously loaded entries are retained; refresh before making changes.'
						this.diagnostics?.record('cli_notice', {
							operation: section.method,
							severity: 'error',
							error: new Error('Pal communication metadata unavailable.'),
						})
					}
				}),
			)
		}
		current()
		this.snapshots.set(key, { scope, view })
		return structuredClone(view)
	}
	private async mutate(
		sessionId: string,
		palId: string,
		snapshotId: string,
		method: string,
		params: (view: PalCommunicationView) => {
			params: Record<string, unknown>
			assertResult(value: unknown): void
		},
	): Promise<PalCommunicationView> {
		const key = this.key(sessionId, palId)
		const saved = this.snapshots.get(key)
		const current = this.capture(sessionId, palId)
		current.assertCurrent()
		if (
			!saved ||
			saved.view.snapshotId !== snapshotId ||
			!saved.view.supported ||
			saved.scope.client !== current.client ||
			saved.scope.runtimeSessionId !== current.runtimeSessionId
		)
			throw new Error('Pal communication changed; refresh before making changes.')
		saved.scope.assertCurrent()
		if (this.mutations.has(palId))
			throw new Error('Wait for this Pal’s communication change to finish.')
		const captured = params(saved.view)
		this.mutations.add(palId)
		// Retain last confirmed rows for failed reads, but consume the admitted token.
		this.snapshots.set(key, { ...saved, view: { ...saved.view, snapshotId: randomUUID() } })
		this.reads.set(key, Symbol('Pal communication mutation'))
		try {
			const result = await current.client.request(method, { palId, ...captured.params })
			current.assertCurrent()
			captured.assertResult(result)
			// The authoritative refresh also observes a partial multi-record setup.
			return await this.read(sessionId, palId, true)
		} catch {
			this.diagnostics?.record('cli_notice', {
				operation: method,
				severity: 'error',
				error: new Error('Pal communication change could not be confirmed.'),
			})
			throw new Error(
				'The change could not be confirmed. Refresh to check current permissions before trying again.',
			)
		} finally {
			this.mutations.delete(palId)
		}
	}
	updatePermission(
		sessionId: string,
		palId: string,
		change: PalPermissionChange,
	): Promise<PalCommunicationView> {
		return this.mutate(
			sessionId,
			palId,
			change?.snapshotId,
			PAL_COMMUNICATION_METHODS[2],
			(view) => {
				const peer = view.peers.find((peer) => peer.palId === change.peerPalId)
				if (
					view.peersNotice ||
					!peer ||
					typeof change.enabled !== 'boolean' ||
					typeof change.allowWake !== 'boolean' ||
					(!change.enabled && change.allowWake)
				)
					throw new Error('Refresh this Pal’s peers before changing permissions.')
				const expected = { enabled: change.enabled, allowWake: change.allowWake }
				return {
					params: { peerPalId: peer.palId, expectedRevision: peer.outgoing.revision, ...expected },
					assertResult(value) {
						const result = readPalPermissionResult(value, palId, peer.palId)
						if (
							result.revision !== peer.outgoing.revision + 1 ||
							result.enabled !== expected.enabled ||
							result.allowWake !== expected.allowWake
						)
							throw new Error('Pal permission change was not confirmed.')
					},
				}
			},
		)
	}
	createSubscription(
		sessionId: string,
		palId: string,
		input: PalSubscriptionCreate,
	): Promise<PalCommunicationView> {
		return this.mutate(
			sessionId,
			palId,
			input?.snapshotId,
			PAL_COMMUNICATION_METHODS[4],
			(view) => {
				const source = view.sources.find((source) => source.palId === input.sourcePalId)
				const conversation = source?.conversations.find((row) => row.id === input.sourceSessionId)
				const recipientKnown =
					input.recipientPalId === palId ||
					view.sources.some((row) => row.palId === input.recipientPalId)
				if (
					view.subscriptionsNotice ||
					!conversation ||
					!recipientKnown ||
					typeof input.wake !== 'boolean' ||
					(input.sourcePalId !== palId && input.recipientPalId !== palId) ||
					input.sourcePalId === input.recipientPalId
				)
					throw new Error('Choose a listed source conversation and recipient for this Pal.')
				const params = {
					sourcePalId: source?.palId,
					sourceSessionId: conversation.id,
					recipientPalId: input.recipientPalId,
					wake: input.wake,
				}
				return {
					params,
					assertResult(value) {
						const result = readPalSubscriptionResult(value, palId)
						if (
							result.sourcePalId !== params.sourcePalId ||
							result.sourceConversationId !== params.sourceSessionId ||
							result.sourceProfileRevision !== conversation.profileRevision ||
							result.recipientPalId !== params.recipientPalId ||
							!result.enabled ||
							!result.permission?.observe ||
							!result.permission.disclose ||
							!result.permission.receive ||
							result.permission.wake !== params.wake
						)
							throw new Error('Pal subscription creation was not confirmed.')
					},
				}
			},
		)
	}
	disableSubscription(
		sessionId: string,
		palId: string,
		input: PalSubscriptionDisable,
	): Promise<PalCommunicationView> {
		return this.mutate(
			sessionId,
			palId,
			input?.snapshotId,
			PAL_COMMUNICATION_METHODS[5],
			(view) => {
				const subscription = view.subscriptions.find((row) => row.id === input.subscriptionId)
				if (view.subscriptionsNotice || !subscription?.enabled)
					throw new Error('Refresh this Pal’s subscriptions before disabling one.')
				return {
					params: { id: subscription.id, expectedRevision: subscription.revision },
					assertResult(value) {
						const result = readPalSubscriptionResult(value, palId)
						if (
							result.id !== subscription.id ||
							result.revision !== subscription.revision + 1 ||
							result.enabled ||
							result.sourcePalId !== subscription.sourcePalId ||
							result.sourceConversationId !== subscription.sourceConversationId ||
							result.sourceProfileRevision !== subscription.sourceProfileRevision ||
							result.recipientPalId !== subscription.recipientPalId
						)
							throw new Error('Pal subscription disable was not confirmed.')
					},
				}
			},
		)
	}
}
