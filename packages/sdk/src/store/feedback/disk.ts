import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { MessageId, RunId } from '../../types/ids/index.js'
import { DiskRecordStore } from '../kv/record-store.js'
import { readRunEventsIn } from '../run/disk.js'
import { defineSchema, stamp } from '../schema.js'
import type { MessageExistenceCheck } from './memory.js'
import {
	type MessageFeedback,
	type MessageFeedbackStore,
	type PutMessageFeedbackInput,
	StaleFeedbackError,
	UnknownMessageError,
} from './types.js'

const SCHEMA = defineSchema({ kind: 'feedback-store', current: 1, migrations: {} })

const records = new DiskRecordStore<MessageFeedback>(SCHEMA)

/**
 * Feedback on disk, one file per rated message.
 *
 * One file rather than one appended log per run, because a rating is a
 * RECORD — it is replaced, not accumulated — and compare-and-set on a
 * record is what stops two raters silently overwriting each other. An
 * append log would have to be replayed to answer "what is the rating now",
 * and two appends racing would both succeed.
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
		const events = await readRunEventsIn(join(runsDir, runId))
		return events.some((event) => (event as { messageId?: string }).messageId === messageId)
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
		return join(this.rootDir, runId)
	}

	async putMessageFeedback(input: PutMessageFeedbackInput): Promise<MessageFeedback> {
		// Validated BEFORE the version check, so a rating aimed at a message
		// that does not exist is refused for what it is rather than reported
		// as a version conflict.
		if (!(await this.messageExists(input.runId, input.messageId))) {
			throw new UnknownMessageError({ runId: input.runId, messageId: input.messageId })
		}

		const dir = this.runDir(input.runId)
		const path = join(dir, fileName(input.messageId))
		const existing = await records.read(path)
		const actualVersion = existing?.ownerVersion ?? 0

		if (input.expectedVersion !== actualVersion) {
			throw new StaleFeedbackError({
				runId: input.runId,
				messageId: input.messageId,
				expectedVersion: input.expectedVersion,
				actualVersion,
			})
		}

		const timestamp = this.now()
		const record: MessageFeedback = {
			runId: input.runId,
			messageId: input.messageId,
			rating: input.rating,
			...(input.note !== undefined ? { note: input.note } : {}),
			ownerVersion: actualVersion + 1,
			createdAt: existing?.createdAt ?? timestamp,
			updatedAt: timestamp,
		}

		await mkdir(dir, { recursive: true })

		if (actualVersion === 0) {
			// EXCLUSIVE create for the first write, and this is the whole
			// compare-and-set on a filesystem. A read-then-write is not
			// atomic: two raters who each read "no feedback yet" both see
			// version 0, both pass the check above, and both write — the
			// second silently discarding the first. `wx` makes the kernel
			// the arbiter, so exactly one of them lands.
			//
			// Found by the conformance suite on the day it was written, with
			// the in-memory store passing the same rule for free because
			// nothing awaits between its read and its write.
			try {
				await writeFile(path, `${JSON.stringify(stamp(SCHEMA, record), null, 2)}\n`, {
					encoding: 'utf-8',
					flag: 'wx',
				})
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
				// Somebody else got there between the read and here. Report
				// what is actually stored now, rather than the 0 we read.
				const winner = await records.read(path)
				throw new StaleFeedbackError({
					runId: input.runId,
					messageId: input.messageId,
					expectedVersion: input.expectedVersion,
					actualVersion: winner?.ownerVersion ?? 1,
				})
			}
			return record
		}

		// An UPDATE is written through the ordinary atomic replace. Two
		// concurrent updates from separate PROCESSES can still interleave
		// between the read above and this write — the file already exists, so
		// there is no exclusive-create to arbitrate, and feedback carries no
		// fencing token the way a run claim does. Said plainly rather than
		// implied by the `expectedVersion` parameter, which reads like a
		// stronger guarantee than a filesystem gives without one.
		await records.write(path, record)
		return record
	}

	async listMessageFeedback(query: { runId: RunId }): Promise<readonly MessageFeedback[]> {
		const dir = this.runDir(query.runId)
		const names = await records.scanNames(dir, '')
		const out: MessageFeedback[] = []
		for (const name of names) {
			if (!name.endsWith('.json')) continue
			const record = await records.read(join(dir, name))
			// A half-written entry from a crashed writer must not make the
			// whole listing unavailable.
			if (record !== null) out.push(record)
		}
		return out
	}
}
