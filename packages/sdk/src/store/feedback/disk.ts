import { join } from 'node:path'

import type { SessionPaths } from '../../session/paths.js'
import { NamzuError } from '../../types/errors/index.js'
import type { MessageId, SessionId } from '../../types/ids/index.js'
import { asMessageId, asSessionId } from '../../utils/id.js'
import { DiskRecordStore } from '../kv/record-store.js'
import {
	DiskRevisionRecordStore,
	type RevisionedRecordLocation,
	decodeRevisionFileSegment,
	revisionFileSegment,
} from '../kv/revision-record-store.js'
import { defineSchema } from '../schema.js'
import { streamSessionLog } from '../session-log/disk.js'
import type { MessageExistenceCheck } from './memory.js'
import {
	type MessageFeedback,
	type MessageFeedbackStore,
	type PutMessageFeedbackInput,
	StaleFeedbackError,
	UnknownMessageError,
} from './types.js'

const SCHEMA = defineSchema({
	kind: 'feedback-store',
	current: 1,
	migrations: {},
})

const records = new DiskRecordStore<MessageFeedback>(SCHEMA)
const revisionRecords = new DiskRevisionRecordStore<MessageFeedback>(
	SCHEMA,
	'message feedback store',
	(record) => record.ownerVersion,
)

/**
 * Feedback on disk, one immutable commit per accepted owner version.
 *
 * A rating is a RECORD — readers want its current value — but replacing one
 * mutable file cannot make the preceding version comparison atomic. The
 * revision directory elects exactly one writer for N+1; the former single
 * file remains only a checked, best-effort compatibility projection.
 */
export interface DiskMessageFeedbackStoreConfig {
	/**
	 * The project's layout. Feedback on a session lives in
	 * `<session-id>/feedback/` (one `<message-id>.json` plus `.revisions/`),
	 * beside the session's log — the log is what a rating is checked against,
	 * so the two are kept and removed together.
	 */
	readonly paths: Pick<SessionPaths, 'feedback' | 'sessionLog'>
}

/** Filesystem-safe file name for one rated message. */
function fileName(messageId: MessageId): string {
	// Retain the historical projection spelling. Callers validate the id
	// first, so suffixes this replacement once flattened are now rejected.
	return `${messageId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
}

/**
 * `hasMessage`, answered by the session's log: does it hold a `message`
 * record with this id?
 *
 * The log is the only record of what a session actually said. A `messageId`
 * that appears nowhere in it is either a typo or a fabrication, and both are
 * worth refusing — a feedback row pointing at a message nobody can find is
 * unreviewable and indistinguishable from a real one. The walk verifies the
 * hash chain as it goes, so a log that was edited by hand refuses the rating
 * rather than vouching for it. A host with a `SessionIndex` at hand can pass
 * its own check instead; the answer must be the same.
 */
export function sessionLogMessageCheck(
	paths: Pick<SessionPaths, 'sessionLog'>,
): MessageExistenceCheck {
	return async (sessionId: SessionId, messageId: MessageId): Promise<boolean> => {
		const checkedSessionId = asSessionId(sessionId)
		const checkedMessageId = asMessageId(messageId)
		const walk = streamSessionLog(paths.sessionLog({ sessionId: checkedSessionId }), {
			sessionId: checkedSessionId,
		})
		for await (const { record } of walk) {
			if (record.type === 'message' && record.messageId === checkedMessageId) return true
		}
		return false
	}
}

export class DiskMessageFeedbackStore implements MessageFeedbackStore {
	private readonly paths: Pick<SessionPaths, 'feedback' | 'sessionLog'>
	private readonly messageExists: MessageExistenceCheck

	constructor(
		config: DiskMessageFeedbackStoreConfig,
		messageExists?: MessageExistenceCheck,
		private readonly now: () => number = Date.now,
	) {
		this.paths = config.paths
		// The session's own log is the default authority on what it said.
		this.messageExists = messageExists ?? sessionLogMessageCheck(config.paths)
	}

	private feedbackDir(sessionId: SessionId): string {
		return this.paths.feedback({ sessionId: asSessionId(sessionId) })
	}

	private revisionsDir(sessionId: SessionId): string {
		return join(this.feedbackDir(sessionId), '.revisions')
	}

	private location(sessionId: SessionId, messageId: MessageId): RevisionedRecordLocation {
		const checkedMessageId = asMessageId(messageId)
		const legacyName = fileName(checkedMessageId)
		return {
			legacyPath: join(this.feedbackDir(sessionId), legacyName),
			revisionsDir: join(this.revisionsDir(sessionId), revisionFileSegment(checkedMessageId)),
			// Preserve the projection guard from the previous layout. Checked ids
			// now retain their spelling; unsafe custom suffixes are rejected above.
			publishLegacyProjection: legacyName === `${checkedMessageId}.json`,
		}
	}

	private assertKey(record: MessageFeedback, sessionId: SessionId, messageId: MessageId): void {
		if (record.sessionId !== sessionId || record.messageId !== messageId) {
			throw new NamzuError({
				code: 'storage_error',
				message: `Message feedback record key mismatch: expected ${sessionId}/${messageId}, found ${record.sessionId}/${record.messageId}. Repair or restore the record before retrying.`,
				details: {
					expectedSessionId: sessionId,
					expectedMessageId: messageId,
					actualSessionId: record.sessionId,
					actualMessageId: record.messageId,
				},
				retryable: false,
			})
		}
	}

	async putMessageFeedback(input: PutMessageFeedbackInput): Promise<MessageFeedback> {
		// Runtime ids cross a public JS boundary. The nominal TypeScript brand can
		// still be asserted, so validate before either an injected callback or a
		// filesystem path sees the values.
		const sessionId = asSessionId(input.sessionId)
		const messageId = asMessageId(input.messageId)
		const location = this.location(sessionId, messageId)

		// Validated BEFORE the version check, so a rating aimed at a message
		// that does not exist is refused for what it is rather than reported
		// as a version conflict.
		if (!(await this.messageExists(sessionId, messageId))) {
			throw new UnknownMessageError({ sessionId, messageId })
		}

		return await revisionRecords.transact(location, (existing) => {
			if (existing) this.assertKey(existing, sessionId, messageId)
			const actualVersion = existing?.ownerVersion ?? 0
			if (input.expectedVersion !== actualVersion) {
				throw new StaleFeedbackError({
					sessionId,
					messageId,
					expectedVersion: input.expectedVersion,
					actualVersion,
				})
			}

			const timestamp = this.now()
			const record: MessageFeedback = {
				sessionId,
				messageId,
				rating: input.rating,
				...(input.note !== undefined ? { note: input.note } : {}),
				ownerVersion: actualVersion + 1,
				createdAt: existing?.createdAt ?? timestamp,
				updatedAt: timestamp,
			}
			return { record, result: record }
		})
	}

	async listMessageFeedback(query: { sessionId: SessionId }): Promise<readonly MessageFeedback[]> {
		const sessionId = asSessionId(query.sessionId)
		const dir = this.feedbackDir(sessionId)
		const ids = new Map<string, MessageId>()

		// Old single-file records are still authoritative until their first
		// current write. Read the body's id rather than attempting to reverse the
		// old lossy filename mapping.
		for (const name of await records.scanNames(dir, '')) {
			if (!name.endsWith('.json')) continue
			const record = await records.read(join(dir, name))
			if (record === null) continue
			const messageId = asMessageId(record.messageId)
			this.assertKey(record, sessionId, messageId)
			if (fileName(messageId) !== name) {
				throw new NamzuError({
					code: 'storage_error',
					message: `Message feedback projection filename ${name} does not match record ${messageId}. Repair or restore the record before retrying.`,
					details: { sessionId, messageId, name },
					retryable: false,
				})
			}
			ids.set(messageId, messageId)
		}

		// The immutable commit is the success boundary. Projection publication is
		// deliberately best-effort, so enumerate canonical revision directories
		// too or a successful first rating can disappear after a crash.
		for (const segment of await records.scanNames(this.revisionsDir(sessionId), '')) {
			const decoded = decodeRevisionFileSegment(segment)
			if (decoded === null) continue
			const messageId = asMessageId(decoded)
			ids.set(messageId, messageId)
		}

		const out: MessageFeedback[] = []
		for (const messageId of [...ids.values()].sort((a, b) => a.localeCompare(b))) {
			const record = await revisionRecords.read(this.location(sessionId, messageId))
			if (record === null) continue
			this.assertKey(record, sessionId, messageId)
			out.push(record)
		}
		return out
	}
}
