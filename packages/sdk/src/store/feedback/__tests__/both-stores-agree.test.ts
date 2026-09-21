import { copyFile, mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { SessionPaths, slugForCwd } from '../../../session/paths.js'
import type { MessageId, SessionId } from '../../../types/ids/index.js'
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

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../__fixtures__/session-log')

// Two real session logs from the shared fixtures, and a message each holds.
const SESSION = '1b898770-f856-497c-a28f-8a3f5aefb0b1' as SessionId // valid.jsonl
const OTHER_SESSION = 'e92ded9b-4935-4c71-8f44-47187b18593d' as SessionId // guardrail-replaced.jsonl
const KNOWN = '18f2480c-1892-471c-8d5c-9c043b583e76' as MessageId
const OTHER_KNOWN = '511af24c-b424-49e9-994b-5f3ccee67e5d' as MessageId
const UNKNOWN = '992a95ec-bc31-4162-bc12-f96fce830cd6' as MessageId

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A project layout holding the two fixture logs where `SessionPaths` puts them. */
async function layout(): Promise<SessionPaths> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-'))
	dirs.push(root)
	const paths = new SessionPaths({ home: root, slug: slugForCwd('/work/fixture') })
	await mkdir(paths.projectDir(), { recursive: true })
	await copyFile(join(FIXTURES, 'valid.jsonl'), paths.sessionLog({ sessionId: SESSION }))
	await copyFile(
		join(FIXTURES, 'guardrail-replaced.jsonl'),
		paths.sessionLog({ sessionId: OTHER_SESSION }),
	)
	return paths
}

const knownIds = new Set<string>([`${SESSION} ${KNOWN}`, `${OTHER_SESSION} ${OTHER_KNOWN}`])

defineMessageFeedbackConformance({
	describe,
	it,
	expect: expect as never,
	label: 'in-memory',
	makeStore: async () => ({
		// The same set the disk store derives from the session logs, stated
		// directly. A memory store that accepted everything would pass the
		// other six rules and fail exactly the one about refusing.
		store: new InMemoryMessageFeedbackStore(async (sessionId, messageId) =>
			knownIds.has(`${sessionId} ${messageId}`),
		),
		sessionId: SESSION,
		knownMessageId: KNOWN,
		unknownMessageId: UNKNOWN,
		otherSessionId: OTHER_SESSION,
		otherKnownMessageId: OTHER_KNOWN,
	}),
})

defineMessageFeedbackConformance({
	describe,
	it,
	expect: expect as never,
	label: 'disk',
	makeStore: async () => ({
		// Derived from real session logs, not from a list handed to the store
		// — which is the property the disk implementation is actually for.
		store: new DiskMessageFeedbackStore({ paths: await layout() }),
		sessionId: SESSION,
		knownMessageId: KNOWN,
		unknownMessageId: UNKNOWN,
		otherSessionId: OTHER_SESSION,
		otherKnownMessageId: OTHER_KNOWN,
	}),
})

describe('feedback on disk lives with its session', () => {
	it('writes under <session-id>/feedback/, beside the log it was checked against', async () => {
		const paths = await layout()
		const store = new DiskMessageFeedbackStore({ paths })
		await store.putMessageFeedback({
			sessionId: SESSION,
			messageId: KNOWN,
			rating: 'good',
			expectedVersion: 0,
		})
		const names = await readdir(paths.feedback({ sessionId: SESSION }))
		expect(names).toContain('.revisions')
		expect(names).toContain(`${KNOWN}.json`)
	})

	it('refuses a message of another session, and a session with no log at all', async () => {
		const paths = await layout()
		const store = new DiskMessageFeedbackStore({ paths })
		await expect(
			store.putMessageFeedback({
				sessionId: SESSION,
				messageId: OTHER_KNOWN,
				rating: 'good',
				expectedVersion: 0,
			}),
		).rejects.toMatchObject({ name: 'UnknownMessageError' })
		await expect(
			store.putMessageFeedback({
				sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
				messageId: KNOWN,
				rating: 'good',
				expectedVersion: 0,
			}),
		).rejects.toThrow(/No message/)
	})
})
