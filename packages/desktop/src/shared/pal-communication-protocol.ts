/** Operator-only metadata. Pal and channel message bodies and journal cursors never enter this view. */
export interface PalPeerPermission {
	revision: number
	enabled: boolean
	allowWake: boolean
}
export interface PalPeerView {
	palId: string
	name: string
	paused: boolean
	outgoing: PalPeerPermission
	incoming: PalPeerPermission
}
export interface PalInboxView {
	id: string
	status: 'pending' | 'claimed' | 'recorded'
	conversationId?: string
	sourceKind: 'pal' | 'host-observation' | 'channel' | 'operator-conversation'
	sourcePalId?: string
	subscriptionId?: string
	observedPalId?: string
	provider?: string
	connectionId?: string
	actorId?: string
	/** The owner's own ordinary conversation that sent the message. */
	operatorSessionId?: string
	/** When the Pal's inbox accepted it, in epoch milliseconds. */
	receivedAt?: number
	/**
	 * What the owner wrote. Present only for a message the owner sent and approved from their own
	 * conversation; messages from Pals and channels never carry their text.
	 */
	text?: string
}
export interface PalSubscriptionView {
	v: 1
	id: string
	revision: number
	configurationRevision: number
	sourcePalId: string
	sourceConversationId: string
	sourceProfileRevision: number
	recipientPalId: string
	enabled: boolean
	permission: {
		revision: number
		observe: boolean
		disclose: boolean
		receive: boolean
		wake: boolean
	} | null
	progress: { lastSequence: number | null }
}
export interface PalSubscriptionSource {
	palId: string
	name: string
	conversations: { id: string; title: string; profileRevision: number }[]
}
export interface PalCommunicationView {
	palId: string
	snapshotId: string
	supported: boolean
	peers: PalPeerView[]
	messages: PalInboxView[]
	subscriptions: PalSubscriptionView[]
	sources: PalSubscriptionSource[]
	peersNotice?: string
	inboxNotice?: string
	subscriptionsNotice?: string
}
export interface PalPermissionChange {
	snapshotId: string
	peerPalId: string
	enabled: boolean
	allowWake: boolean
}
export interface PalSubscriptionCreate {
	snapshotId: string
	sourcePalId: string
	sourceSessionId: string
	recipientPalId: string
	wake: boolean
}
export interface PalSubscriptionDisable {
	snapshotId: string
	subscriptionId: string
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid Pal communication metadata.')
	return value as Record<string, unknown>
}
function text(value: unknown): string {
	if (typeof value !== 'string' || !value || value.length > 1024)
		throw new Error('Invalid Pal communication text.')
	return value
}
function integer(value: unknown, minimum = 0): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
		throw new Error('Invalid Pal communication revision.')
	return value
}
function boolean(value: unknown): boolean {
	if (typeof value !== 'boolean') throw new Error('Invalid Pal communication consent.')
	return value
}
function rows<T>(value: unknown, read: (value: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > 10000)
		throw new Error('Invalid Pal communication list.')
	return value.map(read)
}
function unique<T>(values: T[], id: (value: T) => string): T[] {
	if (new Set(values.map(id)).size !== values.length)
		throw new Error('Duplicate Pal communication metadata.')
	return values
}
function snapshot(value: unknown, palId: string): Record<string, unknown> {
	const record = object(value)
	if (record.v !== 1 || record.palId !== palId)
		throw new Error('Foreign Pal communication metadata.')
	return record
}
function permission(value: unknown): PalPeerPermission {
	const rule = object(value)
	const result = {
		revision: integer(rule.revision),
		enabled: boolean(rule.enabled),
		allowWake: boolean(rule.allowWake),
	}
	if ((!result.enabled && result.allowWake) || (result.revision === 0 && result.enabled))
		throw new Error('Invalid Pal communication consent.')
	return result
}
export function readPalPermissionResult(
	value: unknown,
	palId: string,
	peerPalId: string,
): PalPeerPermission {
	const record = snapshot(value, palId)
	if (record.peerPalId !== peerPalId) throw new Error('Foreign Pal permission update.')
	return permission(record.permission)
}
export function readPalSubscriptionResult(value: unknown, palId: string): PalSubscriptionView {
	const record = snapshot(value, palId)
	const result = readPalSubscriptions(
		{ ...record, subscriptions: [record.subscription], sources: [] },
		palId,
	).subscriptions[0]
	if (!result) throw new Error('Invalid Pal subscription update.')
	return result
}
export function readPalPeers(value: unknown, palId: string): PalPeerView[] {
	return unique(
		rows(snapshot(value, palId).peers, (value) => {
			const peer = object(value)
			const id = text(peer.palId)
			if (id === palId) throw new Error('Invalid Pal peer.')
			return {
				palId: id,
				name: text(peer.name),
				paused: boolean(peer.paused),
				outgoing: permission(peer.outgoing),
				incoming: permission(peer.incoming),
			}
		}),
		(peer) => peer.palId,
	)
}
export function readPalInbox(value: unknown, palId: string): PalInboxView[] {
	return unique(
		rows(snapshot(value, palId).messages, (value) => {
			const message = object(value)
			const status = message.status
			const sourceKind = message.sourceKind
			if (
				(status !== 'pending' && status !== 'claimed' && status !== 'recorded') ||
				(sourceKind !== 'pal' &&
					sourceKind !== 'host-observation' &&
					sourceKind !== 'channel' &&
					sourceKind !== 'operator-conversation')
			)
				throw new Error('Invalid Pal delivery phase.')
			const result: PalInboxView = { id: text(message.id), status, sourceKind }
			for (const key of [
				'conversationId',
				'sourcePalId',
				'subscriptionId',
				'observedPalId',
				'provider',
				'connectionId',
				'actorId',
			] as const) {
				if (message[key] !== undefined) result[key] = text(message[key])
			}
			if (message.receivedAt !== undefined) result.receivedAt = integer(message.receivedAt)
			if (sourceKind === 'operator-conversation') {
				if (message.operatorSessionId !== undefined)
					result.operatorSessionId = text(message.operatorSessionId)
				// Not `text()`: an owner message may be longer than a label.
				if (typeof message.text === 'string' && message.text && message.text.length <= 4000)
					result.text = message.text
			}
			return result
		}),
		(message) => message.id,
	)
}
export function readPalSubscriptions(
	value: unknown,
	palId: string,
): {
	subscriptions: PalSubscriptionView[]
	sources: PalSubscriptionSource[]
} {
	const record = snapshot(value, palId)
	const subscriptions = unique(
		rows(record.subscriptions, (value): PalSubscriptionView => {
			const row = object(value)
			const sourcePalId = text(row.sourcePalId)
			const recipientPalId = text(row.recipientPalId)
			if (row.v !== 1 || (sourcePalId !== palId && recipientPalId !== palId))
				throw new Error('Foreign Pal subscription.')
			const rule = row.permission === null ? null : object(row.permission)
			const progress = object(row.progress)
			return {
				v: 1,
				id: text(row.id),
				revision: integer(row.revision, 1),
				configurationRevision: integer(row.configurationRevision, 1),
				sourcePalId,
				recipientPalId,
				sourceConversationId: text(row.sourceConversationId),
				sourceProfileRevision: integer(row.sourceProfileRevision, 1),
				enabled: boolean(row.enabled),
				permission: rule
					? {
							revision: integer(rule.revision, 1),
							observe: boolean(rule.observe),
							disclose: boolean(rule.disclose),
							receive: boolean(rule.receive),
							wake: boolean(rule.wake),
						}
					: null,
				progress: {
					lastSequence: progress.lastSequence === null ? null : integer(progress.lastSequence),
				},
			}
		}),
		(row) => row.id,
	)
	const sources = unique(
		rows(record.sources, (value) => {
			const source = object(value)
			return {
				palId: text(source.palId),
				name: text(source.name),
				conversations: unique(
					rows(source.conversations, (value) => {
						const conversation = object(value)
						return {
							id: text(conversation.id),
							title: text(conversation.title),
							profileRevision: integer(conversation.profileRevision, 1),
						}
					}),
					(row) => row.id,
				),
			}
		}),
		(row) => row.palId,
	)
	return { subscriptions, sources }
}
