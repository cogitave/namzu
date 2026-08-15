/**
 * One step per iteration, including the turn that produces the answer.
 *
 * `StepResult` is documented as "what one iteration of the agent loop did" and
 * `stepNumber` as "1-based, matching `iteration` on the run events". Both were
 * false for the last turn of every run: `if (forceFinalize || !hasToolCalls)`
 * broke out before `recordStep`, so the events said iteration N happened and
 * the ledger had no entry N.
 *
 * The assertions here are about the LEDGER as a whole rather than about one
 * field, because the defect was never a wrong value — it was an absence, and an
 * absence is only visible against a total. Reconciliation against
 * `run.tokenUsage` is the sharpest form: it cannot pass by accident, and it is
 * the thing a host actually needs when it asks what a run cost.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

function registerEcho(tools: ToolRegistry): void {
	tools.register({
		name: 'echo',
		description: 'Echo the text back.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'ok' }),
	})
}

function baseParams(
	provider: MockLLMProvider,
	tools: ToolRegistry,
	workingDirectory: string,
	maxIterations = 4,
) {
	return {
		provider,
		tools,
		runConfig: {
			model: 'run-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			maxIterations,
			maxResponseTokens: 256,
		},
		agentId: 'agent_step',
		agentName: 'Step Agent',
		workingDirectory,
		sessionId: 'ses_step' as SessionId,
		topicId: 'thd_step' as ThreadId,
		projectId: 'prj_step' as ProjectId,
		tenantId: 'tnt_step' as TenantId,
		retry: false as const,
	}
}

describe('every iteration leaves a step', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function mkWorkdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-step-'))
		workdirs.push(dir)
		return dir
	}

	it('reconciles the ledger with the run total, which it never did before', async () => {
		// The answering turn is the expensive one — it carries the whole
		// conversation as its prompt — so this is scripted with the second turn
		// costing twice the first. Before this change the ledger held 110 of 330
		// tokens and nothing said so.
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				},
				{
					text: 'the answer',
					usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
				},
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			messages: [createUserMessage('hello')],
		})

		const steps = run.steps ?? []
		const ledger = steps.reduce((total, s) => total + s.usage.totalTokens, 0)

		expect(ledger).toBe(run.tokenUsage.totalTokens)
		// Named as well as summed: a ledger that reconciled while attributing
		// everything to one step would satisfy the line above.
		expect(steps.map((s) => s.usage.totalTokens)).toEqual([110, 220])
	})

	it('numbers steps to match the iteration events, which is what the type promises', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] },
				{ toolCalls: [{ id: 'c2', name: 'echo', rawArguments: '{}' }] },
				{ text: 'done' },
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				...baseParams(provider, tools, await mkWorkdir()),
				messages: [createUserMessage('hello')],
			},
			(e) => {
				events.push(e)
			},
		)

		// Read off the EVENTS, not off a constant. `stepNumber` documents itself
		// against them, so the events are the other party to the contract, and a
		// hand-written `[1, 2, 3]` would pass even if both drifted together.
		const iterations = events
			.filter((e) => e.type === 'iteration_completed')
			.map((e) => (e as { iteration: number }).iteration)

		expect(run.steps?.map((s) => s.stepNumber)).toEqual(iterations)
	})

	it('records the answering turn with its content and finish reason', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] },
				{ text: 'the final answer' },
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			messages: [createUserMessage('hello')],
		})

		const last = run.steps?.at(-1)
		expect(last?.content).toBe('the final answer')
		expect(last?.toolCalls).toEqual([])
		// The turn that ends the run is the one a reader most wants to find, and
		// it is the one that was missing.
		expect(last?.finishReason).toBe('stop')
	})

	it('gives a text-only run one step rather than none', async () => {
		// The commonest shape there is: a question, an answer, no tools. It used
		// to produce an empty ledger on a run that plainly did something.
		const provider = new MockLLMProvider({ turns: [{ text: 'just an answer' }] })

		const run = await drainQuery({
			...baseParams(provider, new ToolRegistry(), await mkWorkdir(), 2),
			messages: [createUserMessage('hello')],
		})

		expect(run.steps).toHaveLength(1)
		expect(run.steps?.[0]?.content).toBe('just an answer')
	})

	it('reports each step to `onStepFinish`, including the last', async () => {
		// The callback is the live half of the ledger and it is fed from the same
		// site, so a fix that only filled `run.steps` would leave a host watching
		// steps go by and never seeing the one that mattered.
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] }, { text: 'done' }],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)
		const seen: number[] = []

		await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			onStepFinish: (step: { stepNumber: number }) => {
				seen.push(step.stepNumber)
			},
			messages: [createUserMessage('hello')],
		})

		expect(seen).toEqual([1, 2])
	})
})

/**
 * The branch that had no step is not only the LAST turn.
 *
 * Auto-continuation, the structured-output re-prompt and an answer-review
 * rejection all reach it and then `continue` — each spending a turn's tokens on
 * an iteration that emits its own `iteration_completed`. That is why the record
 * is taken at the top of the branch rather than beside the `break` at its end:
 * recording only the terminal turn would leave these three exactly as they
 * were, and they are the turns a host reviewing a re-prompt loop most wants to
 * count.
 */
describe('an iteration that loops back is still a step', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('records the rejected answer as well as the accepted one', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-step-'))
		workdirs.push(dir)
		const provider = new MockLLMProvider({
			turns: [{ text: 'first attempt' }, { text: 'second attempt' }],
		})
		let asked = 0

		const run = await drainQuery({
			...baseParams(provider, new ToolRegistry(), dir),
			// Rejected once, then accepted. Both turns are iterations; neither
			// called a tool.
			reviewAnswer: async () => {
				asked++
				return asked === 1 ? { accept: false, feedback: 'try again' } : { accept: true }
			},
			messages: [createUserMessage('hello')],
		})

		expect(asked).toBe(2)
		expect(run.steps?.map((s) => s.content)).toEqual(['first attempt', 'second attempt'])
	})
})
