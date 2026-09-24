import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ToolResult } from '../../../types/tool/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import { type ResumeSessionParams, resumeSession } from '../resume-session.js'
import type { TurnStateScope } from '../turn-state.js'
import { heldCheckpointStore, memorySession, records, terminalRecords } from './support/session.js'

/**
 * A tool can ask for a person (`ToolResult.handoff`). The batch's results
 * are committed first; then the turn parks on a checkpoint instead of
 * calling the model again, and a resume continues from there exactly as it
 * does after a provider pause.
 */

const turnConfig = {
	model: 'mock-model',
	timeoutMs: 30_000,
	tokenBudget: 100_000,
	maxIterations: 6,
	maxResponseTokens: 256,
	permissionMode: 'auto',
}

const HANDOFF = {
	kind: 'human-required',
	reason: 'Sign in to example.test in the browser window, then continue.',
	detail: { origin: 'https://example.test' },
} as const

function toolsWithHandoff() {
	const signIn = vi.fn(
		async (): Promise<ToolResult> => ({
			success: false,
			output: 'The page is a sign-in form.',
			error: 'sign-in required',
			handoff: HANDOFF,
		}),
	)
	const sibling = vi.fn(async (): Promise<ToolResult> => ({ success: true, output: 'sibling-ok' }))
	const tools = testToolset(
		{
			name: 'open_page',
			description: 'Open a page',
			inputSchema: z.object({}),
			execute: signIn,
		},
		{
			name: 'note',
			description: 'Take a note',
			inputSchema: z.object({}),
			execute: sibling,
		},
	)
	return { tools, signIn, sibling }
}

async function runUntilHandoff() {
	const session = memorySession()
	const scope: TurnStateScope = {
		turnId: generateTurnId(),
		tenantId: session.tenantId,
		projectId: session.projectId,
		sessionId: session.sessionId,
		topicId: session.topicId,
	}
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{ id: 'call_page', name: 'open_page', rawArguments: '{}' },
					{ id: 'call_note', name: 'note', rawArguments: '{}' },
				],
			},
			{ text: 'signed in and done' },
		],
	})
	const { tools, signIn, sibling } = toolsWithHandoff()
	const common = {
		provider,
		toolsets: [tools],
		agentId: 'agent_handoff',
		agentName: 'Handoff agent',
		workingDirectory: process.cwd(),
		retry: false,
		turnConfig,
	}
	const events: SessionEvent[] = []
	const run = await drainQuery(
		{
			...common,
			...session,
			messages: [{ role: 'user', content: 'open the page' }],
			turnId: scope.turnId,
		} as unknown as QueryParams,
		(event) => {
			events.push(event)
		},
	)
	return { session, scope, provider, events, run, common, signIn, sibling }
}

describe('a tool that asks for a person', () => {
	it('pauses the turn after the batch is committed, without calling the model again', async () => {
		const { session, events, run, provider, signIn, sibling } = await runUntilHandoff()

		expect(signIn).toHaveBeenCalledTimes(1)
		expect(sibling).toHaveBeenCalledTimes(1)
		expect(provider.requests).toHaveLength(1)
		expect(run.stopReason).toBe('paused')

		const paused = events.filter(
			(event): event is Extract<SessionEvent, { type: 'turn_paused' }> =>
				event.type === 'turn_paused',
		)
		expect(paused).toHaveLength(1)
		expect(paused[0]?.handoff).toEqual(HANDOFF)
		expect(paused[0]?.reason).toBe(HANDOFF.reason)
		expect(await terminalRecords(session.sessionLog)).toHaveLength(0)

		// Log order: both tool results, then the checkpoint, then the pause.
		const log = await records(session.sessionLog)
		const toolResults = log
			.map((record, index) => ({ record, index }))
			.filter(({ record }) => record.type === 'message' && record.role === 'tool')
		expect(toolResults).toHaveLength(2)
		const lastResultAt = Math.max(...toolResults.map(({ index }) => index))
		const checkpointAt = log.findIndex(
			(record) =>
				record.type === 'checkpoint_written' &&
				(record as { checkpointId?: string }).checkpointId === paused[0]?.checkpointId,
		)
		const pausedAt = log.findIndex((record) => record.type === 'turn_paused')
		expect(checkpointAt).toBeGreaterThan(lastResultAt)
		expect(pausedAt).toBeGreaterThan(checkpointAt)
		expect(pausedAt).toBe(log.length - 1)
		const pausedRecord = log[pausedAt] as Extract<(typeof log)[number], { type: 'turn_paused' }>
		expect(pausedRecord.handoff).toEqual(HANDOFF)
		expect(pausedRecord.checkpointId).toBe(paused[0]?.checkpointId)
	})

	it('resumes with a model call that sees the results, and runs no tool again', async () => {
		const { session, scope, provider, common, signIn, sibling } = await runUntilHandoff()

		const resumed = await resumeSession({
			...common,
			scope,
			sessionLog: session.sessionLog,
			checkpointStore: await heldCheckpointStore(session.sessionLog),
			sessionId: scope.sessionId,
			topicId: scope.topicId,
			projectId: scope.projectId,
			tenantId: scope.tenantId,
		} as unknown as ResumeSessionParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		expect(resumed.turn.id).toBe(scope.turnId)
		expect(resumed.turn.status).toBe('completed')
		expect(resumed.turn.result).toBe('signed in and done')
		expect(signIn).toHaveBeenCalledTimes(1)
		expect(sibling).toHaveBeenCalledTimes(1)

		expect(provider.requests).toHaveLength(2)
		const seen = JSON.stringify(provider.requests[1]?.messages)
		expect(seen).toContain('The page is a sign-in form.')
		expect(seen).toContain('sibling-ok')
		expect((await terminalRecords(session.sessionLog)).map((r) => r.type)).toEqual([
			'turn_completed',
		])
	})

	it('fails a delegated child’s turn with the reason instead of pausing', async () => {
		const session = memorySession()
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'call_page', name: 'open_page', rawArguments: '{}' }] },
				{ text: 'never asked' },
			],
		})
		const { tools } = toolsWithHandoff()
		const events: SessionEvent[] = []
		const run = await drainQuery(
			{
				provider,
				toolsets: [tools],
				...session,
				parentSessionId: memorySession().sessionId,
				agentId: 'agent_handoff_child',
				agentName: 'Handoff child',
				messages: [{ role: 'user', content: 'open the page' }],
				workingDirectory: process.cwd(),
				retry: false,
				turnConfig,
			} as unknown as QueryParams,
			(event) => {
				events.push(event)
			},
		)

		expect(provider.requests).toHaveLength(1)
		expect(events.some((event) => event.type === 'turn_paused')).toBe(false)
		expect(run.status).toBe('failed')
		expect(run.lastError).toContain(HANDOFF.reason)
		const terminal = await terminalRecords(session.sessionLog)
		expect(terminal.map((record) => record.type)).toEqual(['turn_failed'])
	})
})
