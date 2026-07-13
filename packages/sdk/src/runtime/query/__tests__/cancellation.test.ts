// Current-code invariants asserted (2026-07-13, ses_017):
//
// A cancelled run told the wire it had COMPLETED. `ResultAssembler.completeRun` skipped
// `markCompleted` when the run was already `cancelled` — so the RECORD was honest — and
// then emitted `run_completed` anyway, with an empty `result`. Every consumer that pairs
// `run_completed` with "it worked" was lied to on every single cancellation: the
// embedder's own `signal.abort()`, the durable `cancelRun`, a reviewer answering `abort`.
//
//   - A cancelled run emits `run_cancelled` — exactly once — and NEVER `run_completed`.
//     `run_failed` is not it either: nothing failed, the run was told to stop.
//   - Every cancel path produces the same wire truth, because they all mark the run
//     cancelled before the disposition reaches the assembler:
//       · the signal is already aborted when the run starts;
//       · it aborts while a model call is in flight (the iteration catch);
//       · it aborts between iterations (the guard's hard stop);
//       · `cancelRun` flips `run.json` out of process while the segment drives (noticed
//         at the tool-batch gate, which also stops the tool from running at all);
//       · a reviewer answers `abort`.
//   - A cancel that lands while the LAST model call is in flight is still honoured. The
//     loop breaks `end_turn` without re-reading the disk, so the assembler re-reads it:
//     without that, `markCompleted` overwrites the cancellation the control plane wrote,
//     `finalize()` persists `completed`, and the run the user was told was dead comes to
//     rest completed with a result.
//   - The run's record agrees with its event: `cancelled`, an `endedAt`, and NO `result`
//     (a cancelled run has no answer, so none is promoted).
//   - A completed run is untouched: `run_completed`, a result, no `run_cancelled`.
//   - A suspended run still emits nothing terminal — neither `run_completed` (ses_017 P2)
//     nor `run_cancelled`.
//
// These tests drive the real `query()` loop against a fake provider and a real
// `RunDiskStore`, through the production `drainQuery` entry point.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../types/hitl/index.js'
import type { ProjectId, RunId, SessionId, TenantId, ThreadId } from '../../../types/ids/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../types/provider/index.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { cancelRun } from '../decision/resume.js'
import { drainQuery } from '../index.js'

const RUN_ID = 'run_cancel_test' as RunId
const SESSION_ID = 'ses_test' as SessionId
const THREAD_ID = 'thr_test' as ThreadId
const PROJECT_ID = 'prj_test' as ProjectId
const TENANT_ID = 'tnt_test' as TenantId

const USAGE = {
	promptTokens: 10,
	completionTokens: 10,
	totalTokens: 20,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

function toolCallResponse(): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: {
			role: 'assistant',
			content: 'I will run the tool now',
			toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
		},
		finishReason: 'tool_calls',
		usage: USAGE,
	} as ChatCompletionResponse
}

function stopResponse(text = 'all done'): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: { role: 'assistant', content: text },
		finishReason: 'stop',
		usage: USAGE,
	} as ChatCompletionResponse
}

/** A provider whose every turn is driven by the caller — one response (or side effect) per call. */
function scriptedProvider(
	turns: Array<() => Promise<ChatCompletionResponse> | ChatCompletionResponse>,
): LLMProvider {
	let call = 0
	return {
		id: 'fake',
		name: 'Fake',
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			// The last scripted turn repeats, so a loop that runs one iteration further than
			// the test expected does not crash on an undefined turn — it just ends its turn.
			const turn = turns[Math.min(call, turns.length - 1)] ?? (() => stopResponse())
			call++
			return await turn()
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-ses017-p4-'))
}

function runsDir(cwd: string): string {
	return join(
		new DefaultPathBuilder(join(cwd, '.namzu')).sessionDir(PROJECT_ID, SESSION_ID),
		'runs',
	)
}

function runMetaOnDisk(cwd: string): { status: string; endedAt?: number; result?: string } {
	return JSON.parse(readFileSync(join(runsDir(cwd), RUN_ID, 'run.json'), 'utf-8'))
}

interface Driven {
	run: Run
	events: RunEvent[]
	toolRuns: number
}

/**
 * Drive a full run through the production entry point. `onToolExecute` is the seam a test
 * uses to make something happen WHILE the run is working — an abort, a durable cancel.
 */
async function drive(opts: {
	cwd: string
	provider: LLMProvider
	signal?: AbortSignal
	decision?: HITLResumeDecision
	onToolExecute?: () => Promise<void> | void
}): Promise<Driven> {
	const events: RunEvent[] = []
	let toolRuns = 0

	const noopTool: ToolDefinition<Record<string, never>> = {
		name: 'noop',
		description: 'does nothing',
		inputSchema: z.object({}).strict() as unknown as z.ZodType<
			Record<string, never>,
			z.ZodTypeDef,
			unknown
		>,
		async execute() {
			toolRuns++
			await opts.onToolExecute?.()
			return { success: true, output: 'ok' }
		},
	}

	const tools = new ToolRegistry()
	tools.register(noopTool as unknown as ToolDefinition)

	const run = await drainQuery(
		{
			provider: opts.provider,
			tools,
			runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: opts.cwd,
			messages: [],
			runId: RUN_ID,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			signal: opts.signal,
			resumeHandler: async (_req: HITLDecisionRequest) => opts.decision ?? { action: 'continue' },
		},
		(e) => {
			events.push(e)
		},
	)

	return { run, events, toolRuns }
}

function typesOf(events: RunEvent[]): string[] {
	return events.map((e) => e.type)
}

function countOf(events: RunEvent[], type: string): number {
	return typesOf(events).filter((t) => t === type).length
}

/** The invariant, asserted the same way for every path that can produce a cancellation. */
function expectCancelledOnTheWire(driven: Driven): void {
	expect(typesOf(driven.events)).not.toContain('run_completed')
	expect(typesOf(driven.events)).not.toContain('run_failed')
	expect(countOf(driven.events, 'run_cancelled')).toBe(1)
	expect(driven.events.find((e) => e.type === 'run_cancelled')).toEqual({
		type: 'run_cancelled',
		runId: RUN_ID,
	})
	expect(driven.run.status).toBe('cancelled')
	expect(driven.run.stopReason).toBe('cancelled')
	// A cancelled run has no answer. `markCancelled` never promotes the pending assistant
	// turn, and the event carries no result to invent one from.
	expect(driven.run.result).toBeUndefined()
}

describe('a cancelled run says CANCELLED on the wire, never COMPLETED', () => {
	it('the signal is already aborted when the run starts', async () => {
		const cwd = tmp()
		const driven = await drive({
			cwd,
			provider: scriptedProvider([() => stopResponse()]),
			signal: AbortSignal.abort(),
		})

		expectCancelledOnTheWire(driven)
		expect(runMetaOnDisk(cwd).status).toBe('cancelled')
	})

	it('the signal aborts while a model call is in flight (the iteration catch)', async () => {
		const cwd = tmp()
		const controller = new AbortController()
		const driven = await drive({
			cwd,
			signal: controller.signal,
			provider: scriptedProvider([
				async () => {
					// The abort lands mid-request: the deadline wrapper's abort listener rejects
					// the in-flight call with an `aborted` provider error, which the iteration
					// catch routes to `enterCancellationPath`.
					controller.abort()
					await new Promise((r) => setTimeout(r, 5))
					return stopResponse()
				},
			]),
		})

		expectCancelledOnTheWire(driven)
		expect(runMetaOnDisk(cwd).status).toBe('cancelled')
	})

	it('the signal aborts between iterations (the guard hard stop)', async () => {
		const cwd = tmp()
		const controller = new AbortController()
		const driven = await drive({
			cwd,
			signal: controller.signal,
			// Turn 1 asks for a tool; the tool aborts; the loop reaches the guard at the top
			// of iteration 2 and stops there, before any further model call.
			provider: scriptedProvider([() => toolCallResponse(), () => stopResponse()]),
			onToolExecute: () => controller.abort(),
		})

		expectCancelledOnTheWire(driven)
		expect(driven.toolRuns).toBe(1)
		expect(runMetaOnDisk(cwd).status).toBe('cancelled')
	})

	it('cancelRun flips run.json out of process — and the tool it cancelled never runs', async () => {
		const cwd = tmp()
		const driven = await drive({
			cwd,
			provider: scriptedProvider([
				async () => {
					// The control plane cancels a run that is mid-flight. It takes no lease and
					// raises no signal — the only way the live segment can learn of it is by
					// re-reading the disk, which the tool-batch gate does.
					await cancelRun({ baseDir: runsDir(cwd), runId: RUN_ID })
					return toolCallResponse()
				},
				() => stopResponse(),
			]),
		})

		expectCancelledOnTheWire(driven)
		// The whole point of the gate: the batch the user cancelled did not execute.
		expect(driven.toolRuns).toBe(0)
		expect(runMetaOnDisk(cwd).status).toBe('cancelled')
	})

	it('cancelRun lands while the LAST model call is in flight — the completion does not overwrite it', async () => {
		const cwd = tmp()
		const driven = await drive({
			cwd,
			provider: scriptedProvider([
				async () => {
					// Cancelled during the final call. The loop has already passed its last
					// disk read, the model answers `stop`, and the loop breaks `end_turn` —
					// nothing between here and `finalize()` looks at the run's status again
					// except the assembler.
					await cancelRun({ baseDir: runsDir(cwd), runId: RUN_ID })
					return stopResponse('I finished anyway')
				},
			]),
		})

		expectCancelledOnTheWire(driven)
		// Without the assembler's re-read this said `completed`, with `result: 'I finished
		// anyway'` — over a run the control plane had already reported dead.
		const meta = runMetaOnDisk(cwd)
		expect(meta.status).toBe('cancelled')
		expect(meta.result).toBeUndefined()
	})

	it('a reviewer answers abort', async () => {
		const cwd = tmp()
		const driven = await drive({
			cwd,
			provider: scriptedProvider([() => toolCallResponse()]),
			decision: { action: 'abort', reason: 'no' },
		})

		expectCancelledOnTheWire(driven)
		expect(driven.toolRuns).toBe(0)
		expect(runMetaOnDisk(cwd).status).toBe('cancelled')
	})

	it('the record agrees with the event — cancelled, ended, and with no result', async () => {
		const cwd = tmp()
		const { run } = await drive({
			cwd,
			provider: scriptedProvider([() => stopResponse()]),
			signal: AbortSignal.abort(),
		})

		expect(run.status).toBe('cancelled')
		expect(run.endedAt).toBeTypeOf('number')
		expect(run.result).toBeUndefined()
		expect(runMetaOnDisk(cwd).result).toBeUndefined()
	})
})

describe('the other dispositions are untouched', () => {
	it('a completed run still emits run_completed and no run_cancelled', async () => {
		const cwd = tmp()
		const { run, events } = await drive({
			cwd,
			provider: scriptedProvider([() => stopResponse()]),
		})

		expect(countOf(events, 'run_completed')).toBe(1)
		expect(typesOf(events)).not.toContain('run_cancelled')
		expect(run.status).toBe('completed')
		expect(run.result).toBe('all done')
		expect(runMetaOnDisk(cwd).status).toBe('completed')
	})

	it('a suspended run emits nothing terminal — not run_completed (P2), not run_cancelled', async () => {
		const cwd = tmp()
		const { run, events } = await drive({
			cwd,
			provider: scriptedProvider([() => toolCallResponse()]),
			decision: { action: 'pause', reason: 'need to check with legal' },
		})

		expect(typesOf(events)).toContain('run_paused')
		expect(typesOf(events)).not.toContain('run_completed')
		expect(typesOf(events)).not.toContain('run_cancelled')
		expect(typesOf(events)).not.toContain('run_failed')
		expect(run.status).toBe('awaiting_input')
		expect(runMetaOnDisk(cwd).status).toBe('awaiting_input')
	})
})
