/**
 * A turn left on questions about tool calls is closable only when nobody can
 * answer them any more. A paused turn whose only open questions are tool
 * reviews is; a turn another writer still holds (even one that was killed and
 * has not yet let go of its lease) and a pause on anything else are not.
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	createUserMessage,
	generateCheckpointId,
	generateMessageId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { recordTurn } from '../../../__fixtures__/session-log.js'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import {
	closeSessions,
	openConversationLog,
	openSessions,
	refreshIndex,
	startConversation,
	unansweredReviewPark,
} from '../store.js'

let cwd: string
let stateRoot: string

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-review-park-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-review-park-home-'))
})

afterEach(() => {
	removeTempDir(cwd)
	removeTempDir(stateRoot)
})

function request(type: string) {
	const checkpointId = generateCheckpointId()
	return {
		type: 'decision_requested',
		decisionId: checkpointId,
		checkpointId,
		request: { type, checkpointId },
	}
}

describe('unansweredReviewPark', () => {
	it('finds a paused turn that is waiting only on tool reviews', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		try {
			const id = await startConversation(sessions)
			const turnId = await recordTurn(sessions, id, [createUserMessage('write it')], {
				status: 'paused',
				records: [request('tool_review')],
			})
			expect(await unansweredReviewPark(sessions, id)).toEqual({ turnId })
		} finally {
			await closeSessions(sessions)
		}
	})

	it('leaves a pause that also waits on something else, or on a sign-in', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		try {
			const mixed = await startConversation(sessions)
			await recordTurn(sessions, mixed, [createUserMessage('go')], {
				status: 'paused',
				records: [request('tool_review'), request('user_question')],
			})
			expect(await unansweredReviewPark(sessions, mixed)).toBeUndefined()

			const other = await startConversation(sessions)
			await recordTurn(sessions, other, [createUserMessage('go')], {
				status: 'paused',
				records: [request('plan_approval')],
			})
			expect(await unansweredReviewPark(sessions, other)).toBeUndefined()
		} finally {
			await closeSessions(sessions)
		}
	})

	it('leaves a turn that was answered, and a conversation with no open turn', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		try {
			const settled = await startConversation(sessions)
			await recordTurn(sessions, settled, [createUserMessage('hi')])
			expect(await unansweredReviewPark(sessions, settled)).toBeUndefined()

			const answered = await startConversation(sessions)
			const park = request('tool_review')
			await recordTurn(sessions, answered, [createUserMessage('go')], {
				status: 'paused',
				records: [
					park,
					{
						type: 'decision_resolved',
						decisionId: park.decisionId,
						decision: { action: 'approve_tools' },
						resolvedBy: { kind: 'user', userId: randomUUID(), tenantId: sessions.tenantId },
					},
				],
			})
			expect(await unansweredReviewPark(sessions, answered)).toBeUndefined()
		} finally {
			await closeSessions(sessions)
		}
	})

	it('leaves a turn whose writer still holds the session', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		try {
			const id = await startConversation(sessions)
			const log = openConversationLog(sessions, id)
			// A writer that was killed outright never releases: its lease stays
			// until it expires, and its questions are still its own until then.
			const lease = await log.claim({ holder: `namzu:${process.pid}:turn`, ttlMs: 5 * 60_000 })
			if (!lease) throw new Error('the session was already held')
			const turnId = generateTurnId()
			const userMessageId = generateMessageId()
			await log.beginTurn(lease, {
				turnId,
				userMessageId,
				config: { model: 'test-model', tokenBudget: 100_000, timeoutMs: 600_000 },
			})
			await log.append(lease, {
				turnId,
				...request('tool_review'),
			} as unknown as Parameters<typeof log.append>[1])
			await refreshIndex(sessions, id)
			expect(await unansweredReviewPark(sessions, id)).toBeUndefined()
		} finally {
			await closeSessions(sessions)
		}
	})
})
