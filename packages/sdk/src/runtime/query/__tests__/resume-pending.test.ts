import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DiskCheckpointStore } from '../../../store/run/checkpoint-disk.js'
import type { HITLResumeDecision, ResumeHandler } from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { type RunStateScope, loadRunState } from '../run-state.js'

/**
 * The whole point of #14, end to end: a run parks on a tool approval in
 * ONE `query()` call, that call returns, and a SECOND `query()` — standing
 * in for a different process — honors the approval a human gave in
 * between.
 *
 * Before this, the second call repaired the unanswered `tool_use` blocks
 * away and let the model re-decide, so "yes, delete that row" degraded
 * into "ask the model again and hope it asks for the same thing".
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-resume-'))
	dirs.push(dir)
	return dir
}

/** Records every call so a test can prove a tool did — or did not — run. */
function deleteRowTool(calls: string[]): ToolDefinition<{ id: number }> {
	return {
		name: 'delete_row',
		description: 'Delete a row',
		inputSchema: z.object({ id: z.number() }),
		isDestructive: () => true,
		execute: ({ id }) => {
			calls.push(`delete:${id}`)
			return Promise.resolve({ success: true, output: `deleted ${id}` })
		},
	}
}

interface Harness {
	dir: string
	scope: RunStateScope
	store: DiskCheckpointStore
	calls: string[]
	tools: ToolRegistry
}

async function harness(): Promise<Harness> {
	const dir = await workdir()
	const calls: string[] = []
	const tools = new ToolRegistry()
	tools.register(deleteRowTool(calls) as unknown as ToolDefinition)
	return {
		dir,
		calls,
		tools,
		store: new DiskCheckpointStore({ baseDir: join(dir, 'runs') }),
		scope: {
			tenantId: 'tnt_r' as TenantId,
			projectId: 'prj_r' as ProjectId,
			sessionId: 'ses_r' as SessionId,
			topicId: 'top_r' as ThreadId,
			runId: 'run_r' as RunId,
		},
	}
}

function baseParams(h: Harness, provider: MockLLMProvider, resumeHandler: ResumeHandler) {
	return {
		provider,
		tools: h.tools,
		resumeHandler,
		checkpointStore: h.store,
		runId: h.scope.runId,
		runConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		agentId: 'agent_r',
		agentName: 'Resumable',
		workingDirectory: h.dir,
		sessionId: h.scope.sessionId,
		topicId: h.scope.topicId,
		projectId: h.scope.projectId,
		tenantId: h.scope.tenantId,
	}
}

/** Answers the first review by pausing, which ends the run still parked. */
const pauseOnReview: ResumeHandler = (request) =>
	Promise.resolve(
		request.type === 'tool_review'
			? ({ action: 'pause', reason: 'waiting for a human' } as HITLResumeDecision)
			: ({ action: 'continue' } as HITLResumeDecision),
	)

describe('an approval survives a process boundary', () => {
	it('parks durably, then a second run applies the recorded decision', async () => {
		const h = await harness()

		// --- process 1: run until it parks on the destructive call ---
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 42 } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			messages: [createUserMessage('delete row 42')],
		})
		expect(parked.stopReason).toBe('paused')
		expect(h.calls).toEqual([])

		// --- the handoff: durable state is all process 2 gets ---
		const state = await loadRunState(new DiskCheckpointStore({ baseDir: join(h.dir, 'runs') }), {
			...h.scope,
			runId: parked.id,
		})
		expect(state?.pending?.request.type).toBe('tool_review')
		const recalled =
			state?.pending?.request.type === 'tool_review' ? state.pending.request.toolCalls : []
		expect(recalled.map((tc) => tc.name)).toEqual(['delete_row'])
		expect(recalled[0]?.isDestructive).toBe(true)

		// --- process 2: the human said yes ---
		const second = new MockLLMProvider({ turns: [{ text: 'row 42 is gone' }] })
		const resumed = await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: state?.checkpointId,
			pendingDecision: { action: 'approve_tools' },
		})

		// The approved call ran — without the model being asked to re-decide.
		expect(h.calls).toEqual(['delete:42'])
		expect(resumed.result).toBe('row 42 is gone')
		// And the model saw the tool result, not a repaired-away history.
		const sent = second.requests[0]?.messages ?? []
		expect(sent.some((m) => m.role === 'tool')).toBe(true)
	})

	it('a rejection collected out-of-band steers the model instead of executing', async () => {
		const h = await harness()

		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 7 } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			messages: [createUserMessage('delete row 7')],
		})

		const state = await loadRunState(h.store, { ...h.scope, runId: parked.id })
		const second = new MockLLMProvider({ turns: [{ text: 'understood, leaving it alone' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: state?.checkpointId,
			pendingDecision: { action: 'reject_tools', feedback: 'too risky' },
		})

		expect(h.calls).toEqual([])
		// The refusal rides inside the tool_result, which is what lets a
		// rejection steer rather than merely stop.
		const toolMsg = (second.requests[0]?.messages ?? []).find((m) => m.role === 'tool')
		expect(JSON.stringify(toolMsg)).toContain('too risky')
	})

	it('ignores a decision whose tool calls no longer match — consent is not transferable', async () => {
		const h = await harness()
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 1 } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			messages: [createUserMessage('delete row 1')],
		})

		// Tamper with the recorded request so it describes a different batch.
		const cp = await findPendingCheckpoint(h.store, { ...h.scope, runId: parked.id })
		if (!cp?.pending || cp.pending.request.type !== 'tool_review') throw new Error('no park')
		await h.store.writeCheckpoint(
			{ ...h.scope, runId: parked.id },
			{
				...cp,
				pending: {
					...cp.pending,
					request: {
						...cp.pending.request,
						toolCalls: [{ ...cp.pending.request.toolCalls[0]!, id: 'call_other' }],
					},
				},
			},
		)

		const second = new MockLLMProvider({ turns: [{ text: 'nothing to do' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: cp.id,
			pendingDecision: { action: 'approve_tools' },
		})

		// Falls back to repair-and-re-decide rather than executing a batch
		// nobody approved.
		expect(h.calls).toEqual([])
	})

	it('a decision that does not describe a batch falls back to the repair path', async () => {
		const h = await harness()
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 3 } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			messages: [createUserMessage('delete row 3')],
		})
		const state = await loadRunState(h.store, { ...h.scope, runId: parked.id })

		const second = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: state?.checkpointId,
			// `continue` says nothing about what to do with pending calls.
			pendingDecision: { action: 'continue' },
		})

		expect(h.calls).toEqual([])
	})
})

describe('park recording stays off the hot path', () => {
	it('a handler that answers instantly never writes a park', async () => {
		const h = await harness()
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 5 } }] }, { text: 'done' }],
		})
		const instant = vi.fn<ResumeHandler>(() =>
			Promise.resolve({ action: 'approve_tools' } as HITLResumeDecision),
		)

		const run = await drainQuery({
			...baseParams(h, provider, instant),
			messages: [createUserMessage('delete row 5')],
		})

		expect(h.calls).toEqual(['delete:5'])
		expect(instant).toHaveBeenCalled()
		// The iteration gate runs every iteration; recording each park
		// unconditionally would triple a long run's checkpoint writes to
		// describe a park that never happened.
		expect(await findPendingCheckpoint(h.store, { ...h.scope, runId: run.id })).toBeNull()
	})
})
