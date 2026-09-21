import { describe, expect, it } from 'vitest'

import { ScanSessionIndex } from '../../../store/session-index/scan.js'
import type { SessionId } from '../../../types/ids/index.js'
import { generateSessionId } from '../../../utils/id.js'
import { startIndexedSession } from '../../__fixtures__/indexed-session.js'
import { resolveA2AContext } from '../context.js'
import { mapTurnToA2AEvent } from '../mapper.js'
import { a2aMessageToCreateTurn, mapTurnToA2ATask } from '../task.js'

/**
 * A2A's `contextId` is a namzu **session**, and this pins it.
 *
 * It used to be the project: `runToA2ATask` bound `contextId` to
 * `project_id`, and the create path read it back as `projectId`. Now a
 * context is a session, a task is one turn of it, and the project comes from
 * the host's configuration. The id a peer sends is opaque: it is resolved
 * through the index's `external_refs`, which the index derives from the
 * session's own records, so the mapping survives a rebuild.
 *
 * Each test resolves against a real index fed by a real session log. The
 * host step between "resolve" and "resolve again" is `startIndexedSession`:
 * the new session's first records carry `origin`, and nothing else records
 * the mapping.
 */

async function send(
	index: ScanSessionIndex,
	contextId: string | undefined,
): Promise<{ sessionId: SessionId; contextId: string; created: boolean }> {
	const request = a2aMessageToCreateTurn('worker', {
		...(contextId !== undefined && { contextId }),
		message: { role: 'user', parts: [{ kind: 'text', text: 'go' }] },
	} as never)
	const resolved = await resolveA2AContext(request.contextId, index)
	if (resolved.created) {
		await startIndexedSession(index, resolved.sessionId, resolved.origin ?? request.origin)
	}
	return resolved
}

describe('an A2A context is a session', () => {
	it('maps a context id that is not a UUID onto one session, and reuses it', async () => {
		const index = new ScanSessionIndex()

		const first = await send(index, 'ctx: my conversation / 7')
		expect(first.created).toBe(true)
		expect(first.contextId).toBe('ctx: my conversation / 7')

		const second = await send(index, 'ctx: my conversation / 7')
		expect(second.created).toBe(false)
		expect(second.sessionId).toBe(first.sessionId)
		expect(second.contextId).toBe('ctx: my conversation / 7')
	})

	it('treats a legacy per-project UUID as opaque: a new session, never a project', async () => {
		// A client from before this release still sends its project's UUID.
		const projectUuid = 'b27ca023-39ba-4362-b823-1fc8f4460876'
		const index = new ScanSessionIndex()

		const request = a2aMessageToCreateTurn('worker', {
			contextId: projectUuid,
			message: { role: 'user', parts: [{ kind: 'text', text: 'go' }] },
		} as never)
		// Nothing on the request names a project any more.
		expect(request).not.toHaveProperty('projectId')
		expect(request.origin).toEqual({
			protocol: 'a2a',
			kind: 'prompt',
			externalSessionId: projectUuid,
		})

		const first = await send(index, projectUuid)
		expect(first.created).toBe(true)
		expect(first.sessionId).not.toBe(projectUuid)

		// Its tasks accumulate in that one session.
		const second = await send(index, projectUuid)
		expect(second.sessionId).toBe(first.sessionId)
	})

	it('creates a new session when no context id is sent, and returns its id as the context', async () => {
		const index = new ScanSessionIndex()
		const minted = generateSessionId()

		const resolved = await resolveA2AContext(undefined, index, { newSessionId: () => minted })
		expect(resolved).toMatchObject({ sessionId: minted, contextId: minted, created: true })
		expect(resolved.origin).toEqual({ protocol: 'a2a', kind: 'prompt' })

		await startIndexedSession(index, minted, resolved.origin ?? { protocol: 'a2a' })
		// The peer sends the returned context back, and it names the session.
		const again = await send(index, resolved.contextId)
		expect(again).toMatchObject({ sessionId: minted, created: false })
	})

	it('names the session and the turn on every task and event', () => {
		const sessionId = generateSessionId()
		const task = mapTurnToA2ATask({
			turn_id: '0199b3a0-0000-7000-8000-0000000000a1',
			session_id: sessionId,
			project_id: null,
			agent_id: 'worker',
			status: 'awaiting_input',
			created_at: new Date('2026-09-21').toISOString(),
			config: {},
		} as never)
		expect(task.id).toBe('0199b3a0-0000-7000-8000-0000000000a1')
		expect(task.contextId).toBe(sessionId)
		expect(task.status.state).toBe('input-required')

		const event = mapTurnToA2AEvent(
			{
				type: 'iteration_started',
				sessionId,
				turnId: '0199b3a0-0000-7000-8000-0000000000a1',
				iteration: 1,
			} as never,
			'ctx: my conversation / 7',
		)
		expect(event?.taskId).toBe('0199b3a0-0000-7000-8000-0000000000a1')
		expect(event?.contextId).toBe('ctx: my conversation / 7')
	})
})
