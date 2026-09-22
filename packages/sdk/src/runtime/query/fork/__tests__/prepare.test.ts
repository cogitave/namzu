import { describe, expect, it } from 'vitest'
import type { CheckpointId } from '../../../../types/hitl/index.js'
import type { ToolCallId } from '../../../../types/ids/index.js'
import type { AssistantMessage, Message, ToolMessage } from '../../../../types/message/index.js'
import type { Mutation } from '../../../../types/session/fork.js'
import {
	type CheckpointedSession,
	addCheckpoint,
	checkpointStoreFor,
	sessionWithCheckpoint,
} from '../../__tests__/support/session.js'
import { prepareForkState } from '../prepare.js'

/** What a fork reads: the source session's log, its checkpoints and the turn. */
function source(session: CheckpointedSession) {
	return { sessionLog: session.log, checkpointStore: session.store, scope: session.scope }
}

describe('prepareForkState', () => {
	it('resolves a specific checkpoint and returns the context it covers', async () => {
		const messages: Message[] = [
			{ role: 'user', content: 'start' },
			{ role: 'assistant', content: 'ok' },
		]
		const session = await sessionWithCheckpoint({
			messages,
			checkpointId: '17f1fb6b-0479-40a1-bf1e-115de23b0ba3' as CheckpointId,
			document: { iteration: 3 },
		})

		const prepared = await prepareForkState({
			...source(session),
			fromCheckpoint: '17f1fb6b-0479-40a1-bf1e-115de23b0ba3' as CheckpointId,
		})

		expect(prepared.sourceCheckpoint.checkpointId).toBe('17f1fb6b-0479-40a1-bf1e-115de23b0ba3')
		expect(prepared.messages).toEqual(messages)
		// A fork is a new session; this is where it comes from.
		expect(prepared.forkedFrom).toEqual({
			sessionId: session.sessionId,
			turnId: session.turnId,
			checkpointId: '17f1fb6b-0479-40a1-bf1e-115de23b0ba3',
		})
		expect(prepared.mutations).toEqual([])
	})

	it("resolves 'latest' to the checkpoint with the highest iteration", async () => {
		const session = await sessionWithCheckpoint({ document: { iteration: 1 } })
		const highest = await addCheckpoint(session, { iteration: 5 })
		await addCheckpoint(session, { iteration: 3 })

		const prepared = await prepareForkState({ ...source(session), fromCheckpoint: 'latest' })

		expect(prepared.sourceCheckpoint.checkpointId).toBe(highest)
		expect(prepared.sourceCheckpoint.iteration).toBe(5)
	})

	it("throws when 'latest' is requested but no checkpoints exist", async () => {
		const session = await sessionWithCheckpoint()
		await expect(
			prepareForkState({
				...source(session),
				checkpointStore: checkpointStoreFor(session.log),
				fromCheckpoint: 'latest',
			}),
		).rejects.toThrow(/No checkpoints found/)
	})

	it('throws when a specific checkpoint does not resolve', async () => {
		const session = await sessionWithCheckpoint()
		await expect(
			prepareForkState({
				...source(session),
				fromCheckpoint: 'e8e27c68-a53c-4003-9fbe-3349649af71a' as CheckpointId,
			}),
		).rejects.toThrow(/not found/)
	})

	it('applies injectToolResponse mutations at the fork point', async () => {
		const assistantMsg: AssistantMessage = {
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'call_a', type: 'function', function: { name: 'noop', arguments: '{}' } }],
		}
		const session = await sessionWithCheckpoint({
			messages: [{ role: 'user', content: 'run tool' }, assistantMsg],
		})
		const mutations: Mutation[] = [
			{
				type: 'injectToolResponse',
				toolCallId: 'call_a' as ToolCallId,
				response: { success: true, output: 'mocked-a' },
			},
		]

		const prepared = await prepareForkState({
			...source(session),
			fromCheckpoint: session.checkpointId,
			mutate: mutations,
		})

		expect(prepared.messages).toHaveLength(3)
		const appended = prepared.messages[2] as ToolMessage
		expect(appended.role).toBe('tool')
		expect(appended.toolCallId).toBe('call_a')
		expect(appended.content).toBe('mocked-a')
		expect(prepared.mutations).toEqual(mutations)
	})
})
