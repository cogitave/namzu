import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { TenantId, TopicId } from '../../types/ids/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import { StaleTopicStateError, type TopicState } from '../../types/topic/state.js'
import { DiskRecordStore } from '../kv/record-store.js'
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
const records = new DiskRecordStore<TopicState>(SCHEMA)

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
}

function next(
	topicId: TopicId,
	tenantId: TenantId,
	mode: PermissionMode,
	revision: number,
	now: number,
): TopicState {
	return { topicId, tenantId, revision: revision + 1, permissionMode: mode, updatedAt: now }
}

export class InMemoryTopicStateStore implements TopicStateStore {
	private readonly states = new Map<TopicId, TopicState>()

	constructor(private readonly now: () => number = Date.now) {}

	async getState(topicId: TopicId, tenantId: TenantId): Promise<TopicState | null> {
		const found = this.states.get(topicId)
		// A record from another tenant reads as absent rather than as an
		// error, for the reason the project listing gives: refusing would
		// confirm that somebody else's topic is there.
		return found && found.tenantId === tenantId ? found : null
	}

	async setPermissionMode(
		topicId: TopicId,
		tenantId: TenantId,
		mode: PermissionMode,
		opts: { revision: number },
	): Promise<TopicState> {
		const existing = await this.getState(topicId, tenantId)
		const actual = existing?.revision ?? 0
		if (opts.revision !== actual) {
			throw new StaleTopicStateError({
				topicId,
				expectedRevision: opts.revision,
				actualRevision: actual,
			})
		}
		const record = next(topicId, tenantId, mode, actual, this.now())
		this.states.set(topicId, record)
		return record
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

	private path(topicId: TopicId): string {
		return join(this.config.rootDir, 'topic-state', `${topicId}.json`)
	}

	async getState(topicId: TopicId, tenantId: TenantId): Promise<TopicState | null> {
		const found = await records.read(this.path(topicId))
		return found && found.tenantId === tenantId ? found : null
	}

	async setPermissionMode(
		topicId: TopicId,
		tenantId: TenantId,
		mode: PermissionMode,
		opts: { revision: number },
	): Promise<TopicState> {
		const existing = await this.getState(topicId, tenantId)
		const actual = existing?.revision ?? 0
		if (opts.revision !== actual) {
			throw new StaleTopicStateError({
				topicId,
				expectedRevision: opts.revision,
				actualRevision: actual,
			})
		}
		const record = next(topicId, tenantId, mode, actual, this.now())
		await mkdir(join(this.config.rootDir, 'topic-state'), { recursive: true })
		await records.write(this.path(topicId), record)
		return record
	}
}
