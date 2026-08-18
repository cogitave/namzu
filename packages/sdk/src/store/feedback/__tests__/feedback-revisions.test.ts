import { access, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { asMessageId, asRunId } from '../../../utils/id.js'
import { DiskRecordStore } from '../../kv/record-store.js'
import { legacyRevisionFileSegment, revisionFileSegment } from '../../kv/revision-record-store.js'
import { DiskMessageFeedbackStore } from '../disk.js'
import type { MessageFeedback } from '../types.js'

const RUN = asRunId('run_feedback_revisions')
const MESSAGE = asMessageId('msg_feedback_revisions')
const roots: string[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	await removeTempDirs(roots)
	roots.length = 0
})

async function fixture(messageIds = [MESSAGE]) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-revisions-'))
	roots.push(root)
	const runsDir = join(root, 'runs')
	const feedbackDir = join(root, 'feedback')
	const runDir = join(runsDir, RUN)
	await mkdir(runDir, { recursive: true })
	await writeFile(
		join(runDir, 'transcript.jsonl'),
		`${messageIds
			.map((messageId, index) =>
				JSON.stringify({
					seq: index + 1,
					type: 'text_delta',
					runId: RUN,
					messageId,
				}),
			)
			.join('\n')}\n`,
	)
	return {
		root,
		runsDir,
		feedbackDir,
		store: new DiskMessageFeedbackStore({ rootDir: feedbackDir, runsDir }, undefined, () => 7),
	}
}

function legacyRecord(overrides: Partial<MessageFeedback> = {}): MessageFeedback {
	return {
		runId: RUN,
		messageId: MESSAGE,
		rating: 'good',
		ownerVersion: 1,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	}
}

describe('feedback revision commits', () => {
	it('reads a previous single-file record forward and commits its next owner version', async () => {
		const { feedbackDir, store } = await fixture()
		const runDir = join(feedbackDir, RUN)
		await mkdir(runDir, { recursive: true })
		await writeFile(join(runDir, `${MESSAGE}.json`), JSON.stringify(legacyRecord()), 'utf8')

		const updated = await store.putMessageFeedback({
			runId: RUN,
			messageId: MESSAGE,
			rating: 'bad',
			note: 'new writer',
			expectedVersion: 1,
		})

		expect(updated).toMatchObject({
			ownerVersion: 2,
			rating: 'bad',
			note: 'new writer',
		})
		const immutable = JSON.parse(
			await readFile(join(runDir, '.revisions', revisionFileSegment(MESSAGE), '2.json'), 'utf8'),
		)
		expect(immutable).toMatchObject({
			runId: RUN,
			messageId: MESSAGE,
			ownerVersion: 2,
			rating: 'bad',
			schemaVersion: 1,
		})
	})

	it('reads the previous lossy filename for a non-canonical message id without rewriting it', async () => {
		const legacyMessage = asMessageId('msg_feedback.legacy ü')
		const { feedbackDir, store } = await fixture([legacyMessage])
		const runDir = join(feedbackDir, RUN)
		const oldName = `${legacyMessage.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
		const oldPath = join(runDir, oldName)
		await mkdir(runDir, { recursive: true })
		await writeFile(oldPath, JSON.stringify(legacyRecord({ messageId: legacyMessage })), 'utf8')

		await expect(
			store.putMessageFeedback({
				runId: RUN,
				messageId: legacyMessage,
				rating: 'bad',
				expectedVersion: 1,
			}),
		).resolves.toMatchObject({ ownerVersion: 2, messageId: legacyMessage })
		expect(JSON.parse(await readFile(oldPath, 'utf8'))).toMatchObject({ ownerVersion: 1 })
		await expect(store.listMessageFeedback({ runId: RUN })).resolves.toEqual([
			expect.objectContaining({
				messageId: legacyMessage,
				ownerVersion: 2,
				rating: 'bad',
			}),
		])
	})

	it('lists a committed first rating even when its projection publication fails', async () => {
		const { feedbackDir, store } = await fixture()
		const projection = join(feedbackDir, RUN, `${MESSAGE}.json`)
		const originalWrite = DiskRecordStore.prototype.write
		vi.spyOn(DiskRecordStore.prototype, 'write').mockImplementation(async function (
			this: DiskRecordStore<unknown>,
			path,
			value,
		) {
			if (path === projection) throw new Error('projection unavailable')
			return await originalWrite.call(this, path, value)
		})

		await expect(
			store.putMessageFeedback({
				runId: RUN,
				messageId: MESSAGE,
				rating: 'bad',
				expectedVersion: 0,
			}),
		).resolves.toMatchObject({ ownerVersion: 1, rating: 'bad' })
		await expect(access(projection)).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(store.listMessageFeedback({ runId: RUN })).resolves.toEqual([
			expect.objectContaining({
				messageId: MESSAGE,
				ownerVersion: 1,
				rating: 'bad',
			}),
		])
	})

	it('uses the immutable head when the compatibility projection is behind', async () => {
		const { feedbackDir, store } = await fixture()
		await store.putMessageFeedback({
			runId: RUN,
			messageId: MESSAGE,
			rating: 'good',
			expectedVersion: 0,
		})
		await store.putMessageFeedback({
			runId: RUN,
			messageId: MESSAGE,
			rating: 'bad',
			expectedVersion: 1,
		})
		await writeFile(
			join(feedbackDir, RUN, `${MESSAGE}.json`),
			JSON.stringify(legacyRecord()),
			'utf8',
		)

		await expect(store.listMessageFeedback({ runId: RUN })).resolves.toEqual([
			expect.objectContaining({ ownerVersion: 2, rating: 'bad' }),
		])
	})

	it('refuses equal-version projection and immutable values that disagree', async () => {
		const { feedbackDir, store } = await fixture()
		await store.putMessageFeedback({
			runId: RUN,
			messageId: MESSAGE,
			rating: 'good',
			expectedVersion: 0,
		})
		await writeFile(
			join(feedbackDir, RUN, `${MESSAGE}.json`),
			JSON.stringify(legacyRecord({ rating: 'bad' })),
			'utf8',
		)

		await expect(store.listMessageFeedback({ runId: RUN })).rejects.toThrow(
			/different values at one revision/,
		)
	})

	it('refuses an immutable body filed under another message key', async () => {
		const { feedbackDir, store } = await fixture()
		await store.putMessageFeedback({
			runId: RUN,
			messageId: MESSAGE,
			rating: 'good',
			expectedVersion: 0,
		})
		const projection = join(feedbackDir, RUN, `${MESSAGE}.json`)
		const immutable = join(feedbackDir, RUN, '.revisions', revisionFileSegment(MESSAGE), '1.json')
		const body = JSON.parse(await readFile(immutable, 'utf8')) as Record<string, unknown>
		await unlink(projection)
		await writeFile(immutable, JSON.stringify({ ...body, messageId: 'msg_someone_else' }), 'utf8')

		await expect(store.listMessageFeedback({ runId: RUN })).rejects.toThrow(/record key mismatch/)
	})

	it('deduplicates projection and commit discovery in message-id order', async () => {
		const messages = [
			asMessageId('msg_feedback_z'),
			asMessageId('msg_feedback_a'),
			asMessageId('msg_feedback_m'),
		]
		const { store } = await fixture(messages)
		for (const messageId of messages) {
			await store.putMessageFeedback({
				runId: RUN,
				messageId,
				rating: 'good',
				expectedVersion: 0,
			})
		}

		expect((await store.listMessageFeedback({ runId: RUN })).map((item) => item.messageId)).toEqual(
			[...messages].sort(),
		)
	})

	it('does not publish colliding legacy filenames for distinct message ids', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-message-collision-'))
		roots.push(root)
		const feedbackDir = join(root, 'feedback')
		const first = asMessageId('msg_collision/a')
		const second = asMessageId('msg_collision?a')
		const store = new DiskMessageFeedbackStore({ rootDir: feedbackDir }, async () => true)

		for (const messageId of [first, second]) {
			await store.putMessageFeedback({
				runId: RUN,
				messageId,
				rating: 'good',
				expectedVersion: 0,
			})
		}

		await expect(access(join(feedbackDir, RUN, 'msg_collision_a.json'))).rejects.toMatchObject({
			code: 'ENOENT',
		})
		expect((await store.listMessageFeedback({ runId: RUN })).map((item) => item.messageId)).toEqual(
			[first, second].sort((a, b) => a.localeCompare(b)),
		)
	})

	it('validates and confines run ids before an accepting callback or filesystem write', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-run-id-'))
		roots.push(root)
		const feedbackDir = join(root, 'feedback')
		const exists = vi.fn(async () => true)
		const store = new DiskMessageFeedbackStore({ rootDir: feedbackDir }, exists, () => 1)
		const missingPrefix = '../../outside' as typeof RUN
		const traversal = asRunId('run_x/../../outside')
		const escapedTarget = join(feedbackDir, traversal)

		await expect(
			store.putMessageFeedback({
				runId: missingPrefix,
				messageId: MESSAGE,
				rating: 'good',
				expectedVersion: 0,
			}),
		).rejects.toThrow(/does not start with "run_"/)
		expect(exists).not.toHaveBeenCalled()

		await expect(
			store.putMessageFeedback({
				runId: traversal,
				messageId: MESSAGE,
				rating: 'good',
				expectedVersion: 0,
			}),
		).resolves.toMatchObject({ runId: traversal })
		await expect(access(escapedTarget)).rejects.toMatchObject({
			code: 'ENOENT',
		})
		await expect(
			access(join(feedbackDir, legacyRevisionFileSegment(traversal))),
		).resolves.toBeUndefined()
	})

	it('does not use a traversal-shaped run id to select another transcript', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-run-check-'))
		roots.push(root)
		const runsDir = join(root, 'runs')
		const feedbackDir = join(root, 'feedback')
		const traversal = asRunId('run_x/../../outside')
		const escapedRunDir = join(runsDir, traversal)
		await mkdir(escapedRunDir, { recursive: true })
		await writeFile(
			join(escapedRunDir, 'transcript.jsonl'),
			`${JSON.stringify({
				seq: 1,
				type: 'text_delta',
				runId: traversal,
				messageId: MESSAGE,
			})}\n`,
		)
		const store = new DiskMessageFeedbackStore({ rootDir: feedbackDir, runsDir })

		await expect(
			store.putMessageFeedback({
				runId: traversal,
				messageId: MESSAGE,
				rating: 'good',
				expectedVersion: 0,
			}),
		).rejects.toThrow(/No message/)
		await expect(store.listMessageFeedback({ runId: traversal })).resolves.toEqual([])
	})
})
