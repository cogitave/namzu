import type { TenantId, TopicId } from '../ids/index.js'
import type { PermissionMode } from '../permission/index.js'

/**
 * State that outlives a run but belongs to the conversation, not to a run.
 *
 * `PermissionMode` was resolved once per run and copied into the executor,
 * so leaving plan mode meant ending the run and starting a fresh one with
 * `permissionMode: 'auto'` — discarding the in-flight step and the
 * tool-schema context with it. The look-around, propose, get-approval,
 * continue-in-the-SAME-conversation flow could not be built on that, and
 * `approve_plan` already existed with its approval changing nothing about
 * the mode.
 *
 * Its own record beside the Topic rather than a field on it, with its own
 * schema version. The Topic record is identity and ownership; this is
 * mutable session state that changes several times within one conversation
 * and whose writers are not the Topic's writers. Merging them would make
 * every mode toggle a CAS conflict against a title rename.
 */
export interface TopicState {
	readonly topicId: TopicId
	readonly tenantId: TenantId
	/**
	 * Compare-and-set counter, starting at 0 for a record's first write.
	 *
	 * Separate from the Topic's `ownerVersion` on purpose — see above. A
	 * host toggling the mode and a manager renaming the topic must not
	 * invalidate each other.
	 */
	readonly revision: number
	readonly permissionMode: PermissionMode
	readonly updatedAt: number
}

/** A write whose `revision` no longer matches what is stored. */
export class StaleTopicStateError extends Error {
	readonly details: {
		topicId: TopicId
		expectedRevision: number
		actualRevision: number
	}

	constructor(details: { topicId: TopicId; expectedRevision: number; actualRevision: number }) {
		super(
			`Stale topic state for ${details.topicId}: expected revision=${details.expectedRevision}, actual=${details.actualRevision}`,
		)
		this.name = 'StaleTopicStateError'
		this.details = details
	}
}
