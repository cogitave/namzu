import { join } from 'node:path'

import { NamzuError } from '../../types/errors/index.js'
import type { MessageId, RunId } from '../../types/ids/index.js'
import { asMessageId, asRunId } from '../../utils/id.js'
import { DiskRecordStore } from '../kv/record-store.js'
import {
	DiskRevisionRecordStore,
	type RevisionedRecordLocation,
	decodeRevisionFileSegment,
	legacyRevisionFileSegment,
	revisionFileSegment,
} from '../kv/revision-record-store.js'
import { readRunEventsIn } from '../run/disk.js'
import { defineSchema } from '../schema.js'
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
	/** Where feedback lives. Sibling of the run tree, not inside it. */
	readonly rootDir: string
	/**
	 * Where run transcripts live, for validating that a rated message exists.
	 *
	 * Separate from `rootDir` because feedback outlives a run directory a
	 * host may prune, and because a store told to validate against a tree it
	 * cannot see should say so rather than accept everything.
	 */
	readonly runsDir?: string
}

/** Filesystem-safe file name for one rated message. */
function fileName(messageId: MessageId): string {
	// Message ids are `msg_` + an alphabet with no separators, so this is a
	// pass-through today. Written as a function anyway: the day an id gains
	// a `/` is the day this silently starts writing outside its directory.
	return `${messageId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
}

/**
 * Does this run's transcript mention this message?
 *
 * Reads the run's own event log, which is the only record of what a run
 * actually produced. A `messageId` that appears nowhere in it is either a
 * typo or a fabrication, and both are worth refusing — a feedback row
 * pointing at a message nobody can find is unreviewable and
 * indistinguishable from a real one.
 */
export function runEventMessageCheck(runsDir: string): MessageExistenceCheck {
	return async (runId: RunId, messageId: MessageId): Promise<boolean> => {
		const checkedRunId = asRunId(runId)
		const checkedMessageId = asMessageId(messageId)
		const events = await readRunEventsIn(join(runsDir, legacyRevisionFileSegment(checkedRunId)))
		return events.some((event) => (event as { messageId?: string }).messageId === checkedMessageId)
	}
}

export class DiskMessageFeedbackStore implements MessageFeedbackStore {
	private readonly rootDir: string
	private readonly messageExists: MessageExistenceCheck

	constructor(
		config: DiskMessageFeedbackStoreConfig,
		messageExists?: MessageExistenceCheck,
		private readonly now: () => number = Date.now,
	) {
		this.rootDir = config.rootDir
		this.messageExists =
			messageExists ??
			// No `runsDir` means nothing to validate against. Accepting
			// everything would be the quiet degradation this repo's rule
			// forbids, so a store built that way refuses every write and names
			// the missing configuration.
			(config.runsDir
				? runEventMessageCheck(config.runsDir)
				: async (runId, messageId) => {
						throw new UnknownMessageError({ runId, messageId })
					})
	}

	private runDir(runId: RunId): string {
		return join(this.rootDir, legacyRevisionFileSegment(asRunId(runId)))
	}

	private revisionsDir(runId: RunId): string {
		return join(this.runDir(runId), '.revisions')
	}

	private location(runId: RunId, messageId: MessageId): RevisionedRecordLocation {
		const checkedMessageId = asMessageId(messageId)
		const legacyName = fileName(checkedMessageId)
		return {
			legacyPath: join(this.runDir(runId), legacyName),
			revisionsDir: join(this.revisionsDir(runId), revisionFileSegment(checkedMessageId)),
			// The previous filename replacement is lossy for punctuation and
			// separators. Read such a legacy path forward if it exists, but never
			// publish a new projection that could overwrite another message's file.
			publishLegacyProjection: legacyName === `${checkedMessageId}.json`,
		}
	}

	private assertKey(record: MessageFeedback, runId: RunId, messageId: MessageId): void {
		if (record.runId !== runId || record.messageId !== messageId) {
			throw new NamzuError({
				code: 'storage_error',
				message: `Message feedback record key mismatch: expected ${runId}/${messageId}, found ${record.runId}/${record.messageId}. Repair or restore the record before retrying.`,
				details: {
					expectedRunId: runId,
					expectedMessageId: messageId,
					actualRunId: record.runId,
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
		const runId = asRunId(input.runId)
		const messageId = asMessageId(input.messageId)
		const location = this.location(runId, messageId)

		// Validated BEFORE the version check, so a rating aimed at a message
		// that does not exist is refused for what it is rather than reported
		// as a version conflict.
		if (!(await this.messageExists(runId, messageId))) {
			throw new UnknownMessageError({ runId, messageId })
		}

		return await revisionRecords.transact(location, (existing) => {
			if (existing) this.assertKey(existing, runId, messageId)
			const actualVersion = existing?.ownerVersion ?? 0
			if (input.expectedVersion !== actualVersion) {
				throw new StaleFeedbackError({
					runId,
					messageId,
					expectedVersion: input.expectedVersion,
					actualVersion,
				})
			}

			const timestamp = this.now()
			const record: MessageFeedback = {
				runId,
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

	async listMessageFeedback(query: { runId: RunId }): Promise<readonly MessageFeedback[]> {
		const runId = asRunId(query.runId)
		const dir = this.runDir(runId)
		const ids = new Map<string, MessageId>()

		// Old single-file records are still authoritative until their first
		// current write. Read the body's id rather than attempting to reverse the
		// old lossy filename mapping.
		for (const name of await records.scanNames(dir, '')) {
			if (!name.endsWith('.json')) continue
			const record = await records.read(join(dir, name))
			if (record === null) continue
			const messageId = asMessageId(record.messageId)
			this.assertKey(record, runId, messageId)
			if (fileName(messageId) !== name) {
				throw new NamzuError({
					code: 'storage_error',
					message: `Message feedback projection filename ${name} does not match record ${messageId}. Repair or restore the record before retrying.`,
					details: { runId, messageId, name },
					retryable: false,
				})
			}
			ids.set(messageId, messageId)
		}

		// The immutable commit is the success boundary. Projection publication is
		// deliberately best-effort, so enumerate canonical revision directories
		// too or a successful first rating can disappear after a crash.
		for (const segment of await records.scanNames(this.revisionsDir(runId), '')) {
			const decoded = decodeRevisionFileSegment(segment)
			if (decoded === null) continue
			const messageId = asMessageId(decoded)
			ids.set(messageId, messageId)
		}

		const out: MessageFeedback[] = []
		for (const messageId of [...ids.values()].sort((a, b) => a.localeCompare(b))) {
			const record = await revisionRecords.read(this.location(runId, messageId))
			if (record === null) continue
			this.assertKey(record, runId, messageId)
			out.push(record)
		}
		return out
	}
}
