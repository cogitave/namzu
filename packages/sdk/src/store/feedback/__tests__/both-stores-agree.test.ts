import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { MessageId, RunId } from '../../../types/ids/index.js'
import { defineMessageFeedbackConformance } from '../conformance.js'
import { DiskMessageFeedbackStore } from '../disk.js'
import { InMemoryMessageFeedbackStore } from '../memory.js'

/**
 * One contract, both implementations.
 *
 * Written this way because the two built-in checkpoint stores diverged at
 * exactly their enforcement point once already, and the one documented as
 * the reference was the one carrying the defect. A suite both run is the
 * only arrangement where a property proven for one is proven for both.
 */

const RUN = 'run_feedback_a' as RunId
const OTHER_RUN = 'run_feedback_b' as RunId
const KNOWN = 'msg_known' as MessageId
const OTHER_KNOWN = 'msg_other' as MessageId
const UNKNOWN = 'msg_never_emitted' as MessageId

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A transcript naming exactly the messages a run produced. */
async function writeTranscript(runsDir: string, runId: RunId, messageIds: MessageId[]) {
	const dir = join(runsDir, runId)
	await mkdir(dir, { recursive: true })
	await writeFile(
		join(dir, 'transcript.jsonl'),
		`${messageIds
			.map((messageId, i) =>
				JSON.stringify({ seq: i + 1, type: 'text_delta', runId, messageId, text: 'x' }),
			)
			.join('\n')}\n`,
	)
}

const knownIds = new Set<string>([`${RUN} ${KNOWN}`, `${OTHER_RUN} ${OTHER_KNOWN}`])

defineMessageFeedbackConformance({
	describe,
	it,
	expect: expect as never,
	label: 'in-memory',
	makeStore: async () => ({
		// The same set the disk store derives from a transcript, stated
		// directly. A memory store that accepted everything would pass the
		// other six rules and fail exactly the one about refusing.
		store: new InMemoryMessageFeedbackStore(async (runId, messageId) =>
			knownIds.has(`${runId} ${messageId}`),
		),
		runId: RUN,
		knownMessageId: KNOWN,
		unknownMessageId: UNKNOWN,
		otherRunId: OTHER_RUN,
		otherKnownMessageId: OTHER_KNOWN,
	}),
})

defineMessageFeedbackConformance({
	describe,
	it,
	expect: expect as never,
	label: 'disk',
	makeStore: async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-'))
		dirs.push(root)
		const runsDir = join(root, 'runs')
		// Derived from a real transcript, not from a list handed to the store
		// — which is the property the disk implementation is actually for.
		await writeTranscript(runsDir, RUN, [KNOWN])
		await writeTranscript(runsDir, OTHER_RUN, [OTHER_KNOWN])
		return {
			store: new DiskMessageFeedbackStore({ rootDir: join(root, 'feedback'), runsDir }),
			runId: RUN,
			knownMessageId: KNOWN,
			unknownMessageId: UNKNOWN,
			otherRunId: OTHER_RUN,
			otherKnownMessageId: OTHER_KNOWN,
		}
	},
})

describe('a feedback store with nothing to validate against', () => {
	it('refuses every write rather than accepting everything', async () => {
		// A store built without a `runsDir` cannot tell a real message from a
		// fabricated one. Accepting on the grounds that it cannot check is
		// the quiet degradation `refuse-do-not-degrade` exists to stop — and
		// it is the shape a host reaches for first, because omitting one
		// config field is easier than wiring a run directory.
		const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-novalidate-'))
		dirs.push(root)
		const store = new DiskMessageFeedbackStore({ rootDir: root })

		await expect(
			store.putMessageFeedback({
				runId: RUN,
				messageId: KNOWN,
				rating: 'good',
				expectedVersion: 0,
			}),
		).rejects.toThrow(/No message/)
		expect(await store.listMessageFeedback({ runId: RUN })).toHaveLength(0)
	})
})
