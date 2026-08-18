import { join } from 'node:path'

import { TenantIsolationError } from '../../session/errors.js'
import type { TenantId, TopicId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import { StaleTopicStateError, type TopicState } from '../../types/topic/state.js'
import {
	DiskRevisionRecordStore,
	type RevisionMutation,
	type RevisionedRecordLocation,
	legacyRevisionFileSegment,
	revisionFileSegment,
} from '../kv/revision-record-store.js'
import { defineSchema } from '../schema.js'

/**
 * Where a conversation's mutable state lives between runs.
 *
 * Its own store rather than a field on the Topic record, and its own file
 * rather than a column: the Topic is identity and ownership, this is
 * session state that changes several times inside one conversation. Merging
 * them would make every mode toggle a compare-and-set conflict against a
 * title rename.
 *
 * A separate store rather than an extension of `TopicStore` because there
 * is no disk `TopicStore` to extend — topics are in-memory everywhere in
 * this tree today. Persisting the state on its own is what the durability
 * this exists for actually needs; building a whole topic disk store to
 * carry one field would be a much larger change nobody asked for, and this
 * record is designed to be folded into one if that arrives.
 */

const SCHEMA = defineSchema({ kind: 'topic-state', current: 1, migrations: {} })
const revisionRecords = new DiskRevisionRecordStore<TopicState>(SCHEMA, 'topic state store')

export interface TopicStateStore {
	/** `null` when this topic has never had state written. */
	getState(topicId: TopicId, tenantId: TenantId): Promise<TopicState | null>
	/**
	 * Compare-and-set on `revision`, `0` for a first write.
	 *
	 * Rejects a stale revision the way `updateTopic` rejects a stale
	 * `ownerVersion`. Two hosts toggling one conversation's mode is not
	 * hypothetical — a TUI and a webhook on the same topic — and
	 * last-write-wins there silently reopens a mode somebody just closed.
	 */
	setPermissionMode(
		topicId: TopicId,
		tenantId: TenantId,
		mode: PermissionMode,
		opts: { readonly revision: number },
	): Promise<TopicState>

	/**
	 * Replace the next-run queue, under the same compare-and-set.
	 *
	 * Replace rather than append, so the caller that read the list is the
	 * one that decides what the new one is — an append primitive would let
	 * a caller add to a list it had never seen.
	 */
	setQueuedMessages(
		topicId: TopicId,
		tenantId: TenantId,
		messages: readonly Message[],
		opts: { readonly revision: number },
	): Promise<TopicState>
}

/** The record after one accepted write. */
function next(
	topicId: TopicId,
	tenantId: TenantId,
	previous: TopicState | null,
	patch: { permissionMode?: PermissionMode; queuedMessages?: readonly Message[] },
	now: number,
): TopicState {
	return {
		topicId,
		tenantId,
		revision: (previous?.revision ?? 0) + 1,
		permissionMode: patch.permissionMode ?? previous?.permissionMode ?? 'auto',
		...(patch.queuedMessages !== undefined
			? { queuedMessages: patch.queuedMessages }
			: previous?.queuedMessages
				? { queuedMessages: previous.queuedMessages }
				: {}),
		updatedAt: now,
	}
}

function assertTenant(record: TopicState, tenantId: TenantId): void {
	if (record.tenantId !== tenantId) {
		throw new TenantIsolationError({
			requested: tenantId,
			resource: `topic-state(${record.topicId})`,
		})
	}
}

function assertFresh(topicId: TopicId, actual: number, expected: number): void {
	if (expected !== actual) {
		throw new StaleTopicStateError({
			topicId,
			expectedRevision: expected,
			actualRevision: actual,
		})
	}
}

function proposeState(
	topicId: TopicId,
	tenantId: TenantId,
	patch: { permissionMode?: PermissionMode; queuedMessages?: readonly Message[] },
	revision: number,
	now: () => number,
	existing: TopicState | null,
): RevisionMutation<TopicState, TopicState> {
	if (existing) assertTenant(existing, tenantId)
	assertFresh(topicId, existing?.revision ?? 0, revision)
	const record = next(topicId, tenantId, existing, patch, now())
	return { record, result: record }
}

export class InMemoryTopicStateStore implements TopicStateStore {
	private readonly states = new Map<TopicId, TopicState>()

	constructor(private readonly now: () => number = Date.now) {}

	async getState(topicId: TopicId, tenantId: TenantId): Promise<TopicState | null> {
		const found = this.states.get(topicId)
		return found && found.tenantId === tenantId ? found : null
	}

	async setPermissionMode(
		topicId: TopicId,
		tenantId: TenantId,
		mode: PermissionMode,
		opts: { revision: number },
	): Promise<TopicState> {
		// Deliberately no await: read, domain checks and publish are one JS turn.
		// Awaiting an async get here lets two callers capture the same revision.
		const proposal = proposeState(
			topicId,
			tenantId,
			{ permissionMode: mode },
			opts.revision,
			this.now,
			this.states.get(topicId) ?? null,
		)
		this.states.set(topicId, proposal.record)
		return proposal.result
	}

	async setQueuedMessages(
		topicId: TopicId,
		tenantId: TenantId,
		messages: readonly Message[],
		opts: { revision: number },
	): Promise<TopicState> {
		const proposal = proposeState(
			topicId,
			tenantId,
			{ queuedMessages: messages },
			opts.revision,
			this.now,
			this.states.get(topicId) ?? null,
		)
		this.states.set(topicId, proposal.record)
		return proposal.result
	}
}

export interface DiskTopicStateStoreConfig {
	/** The session root. State lives under `<rootDir>/topic-state/`. */
	readonly rootDir: string
}

export class DiskTopicStateStore implements TopicStateStore {
	constructor(
		private readonly config: DiskTopicStateStoreConfig,
		private readonly now: () => number = Date.now,
	) {}

	private location(topicId: TopicId): RevisionedRecordLocation {
		const root = join(this.config.rootDir, 'topic-state')
		const segment = revisionFileSegment(topicId)
		return {
			legacyPath: join(root, `${legacyRevisionFileSegment(topicId)}.json`),
			revisionsDir: join(root, '.revisions', segment),
		}
	}

	async getState(topicId: TopicId, tenantId: TenantId): Promise<TopicState | null> {
		const found = await revisionRecords.read(this.location(topicId))
		return found && found.tenantId === tenantId ? found : null
	}

	async setPermissionMode(
		topicId: TopicId,
		tenantId: TenantId,
		mode: PermissionMode,
		opts: { revision: number },
	): Promise<TopicState> {
		return await revisionRecords.transact(this.location(topicId), (existing) =>
			proposeState(topicId, tenantId, { permissionMode: mode }, opts.revision, this.now, existing),
		)
	}

	async setQueuedMessages(
		topicId: TopicId,
		tenantId: TenantId,
		messages: readonly Message[],
		opts: { revision: number },
	): Promise<TopicState> {
		return await revisionRecords.transact(this.location(topicId), (existing) =>
			proposeState(
				topicId,
				tenantId,
				{ queuedMessages: messages },
				opts.revision,
				this.now,
				existing,
			),
		)
	}
}
