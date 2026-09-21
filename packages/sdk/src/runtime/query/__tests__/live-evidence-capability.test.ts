import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { PrepareStepContext } from '../../../types/session/prepare-step.js'
import type { ToolContext } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { EventTranslator } from '../events.js'
import { drainQuery } from '../index.js'

/** An in-memory session: its log has no retained text to capture. */
function memorySession() {
	const sessionId = generateSessionId()
	return { sessionId, sessionLog: new InMemorySessionLog({ sessionId }) }
}

afterEach(() => {
	vi.restoreAllMocks()
})

/**
 * Run `hook` inside every evidence capture, after the translator's own
 * checks passed: where a backend's read of the session log would run.
 */
function interceptCapture(
	hook: (maxReadBytes?: number, signal?: AbortSignal) => Promise<undefined>,
): void {
	const real = EventTranslator.prototype.captureSessionEvidence
	vi.spyOn(EventTranslator.prototype, 'captureSessionEvidence').mockImplementation(async function (
		this: EventTranslator,
		maxReadBytes?: number,
		signal?: AbortSignal,
	) {
		await real.call(this, maxReadBytes, signal)
		return hook(maxReadBytes, signal)
	})
}

it('revokes a timed-out tool capture while the next tool can still read evidence', async () => {
	let release!: () => void
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	const captureTextEvidence = vi.fn(async () => {
		await gate
		return undefined
	})
	let held: ToolContext['captureSessionEvidence']
	let lateReturn = false
	let refused: unknown
	let nextRead = false
	let settledRead = false
	const tools = new ToolRegistry()
	tools.register({
		name: 'slow_capture',
		description: 'Capture with a controlled delay.',
		inputSchema: z.object({}),
		timeoutMs: 50,
		maxRetries: 0,
		execute: async (_input, context) => {
			held = context.captureSessionEvidence
			context.abortSignal.addEventListener('abort', release, { once: true })
			try {
				await held!()
				lateReturn = true
			} catch (error) {
				refused = error
			}
			return { success: true, output: 'Finished observing cancellation.' }
		},
	})
	tools.register({
		name: 'next_capture',
		description: 'Read after another tool timed out.',
		inputSchema: z.object({}),
		execute: async (_input, context) => {
			try {
				await held!()
				settledRead = true
			} catch {
				/* the old tool no longer owns capture */
			}
			await context.captureSessionEvidence!()
			nextRead = true
			return { success: true, output: 'The next tool still owns its read.' }
		},
	})
	interceptCapture(captureTextEvidence)
	const run = await drainQuery({
		turnId: generateTurnId(),
		provider: new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'slow', name: 'slow_capture', args: {} }] },
				{ toolCalls: [{ id: 'next', name: 'next_capture', args: {} }] },
				{ text: 'Done.' },
			],
		}),
		tools,
		projectId: generateProjectId(),
		...memorySession(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		workingDirectory: process.cwd(),
		agentId: 'capture-check',
		agentName: 'Capture check',
		messages: [{ role: 'user', content: 'Inspect evidence, then continue after the deadline.' }],
		turnConfig: {
			model: 'mock',
			maxIterations: 4,
			tokenBudget: 100_000,
			timeoutMs: 10_000,
			permissionMode: 'auto',
		},
	})
	expect(run.status).toBe('completed')
	expect(nextRead).toBe(true)
	expect(lateReturn).toBe(false)
	expect(refused).toBeInstanceOf(Error)
	expect(settledRead).toBe(false)
	expect(captureTextEvidence).toHaveBeenCalledTimes(2)
})

it('local preparation cancellation refuses late capture without cancelling the run', async () => {
	const local = new AbortController()
	const captureTextEvidence = vi.fn(async () => {
		local.abort(new Error('local deadline'))
		return undefined
	})
	interceptCapture(captureTextEvidence)
	let held: PrepareStepContext['captureSessionEvidence']
	const result = await drainQuery({
		turnId: generateTurnId(),
		provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
		tools: new ToolRegistry(),
		projectId: generateProjectId(),
		...memorySession(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		workingDirectory: process.cwd(),
		agentId: 'capture-check',
		agentName: 'Capture check',
		messages: [{ role: 'user', content: 'Inspect the recorded boundary.' }],
		turnConfig: { model: 'mock', maxIterations: 2, tokenBudget: 100_000, timeoutMs: 10_000 },
		prepareStep: async ({ captureSessionEvidence }) => {
			held = captureSessionEvidence
			await expect(captureSessionEvidence!(2 * 1024 * 1024, local.signal)).rejects.toThrow(
				'local deadline',
			)
			await expect(captureSessionEvidence!(2 * 1024 * 1024, local.signal)).rejects.toThrow(
				'local deadline',
			)
			return undefined
		},
	})
	expect(result.stopReason).toBe('end_turn')
	expect(captureTextEvidence).toHaveBeenCalledTimes(1)
	await expect(held!()).rejects.toThrow('active invocation')
})

it.each(
	[false, true].flatMap((cancelDuringCapture) =>
		['tool', 'prepare'].map((entry) => ({ cancelDuringCapture, entry })),
	),
)(
	'keeps $entry capture invocation-bound when cancellation during capture is $cancelDuringCapture',
	async ({ cancelDuringCapture, entry }) => {
		const caller = new AbortController()
		if (cancelDuringCapture) {
			interceptCapture(async () => {
				caller.abort(new Error('operator cancelled during capture'))
				return undefined
			})
		}
		let capture: ToolContext['captureSessionEvidence']
		let returned = false
		let refused = false
		const tools = new ToolRegistry()
		tools.register({
			name: 'capture_evidence',
			description: 'Read the current invocation boundary.',
			inputSchema: z.object({}),
			execute: async (_input, context) => {
				capture = context.captureSessionEvidence
				try {
					expect(await capture!()).toBeUndefined()
					returned = true
					return { success: true, output: 'This backend has no retained text capability.' }
				} catch (error) {
					refused = true
					throw error
				}
			},
		})
		const prepare = async (context: {
			captureSessionEvidence?: ToolContext['captureSessionEvidence']
		}) => {
			capture = context.captureSessionEvidence
			try {
				expect(await capture!()).toBeUndefined()
				returned = true
			} catch (error) {
				refused = true
				throw error
			}
			return undefined
		}
		const run = await drainQuery({
			turnId: generateTurnId(),
			provider: new MockLLMProvider({
				turns:
					entry === 'prepare'
						? [{ text: 'Done.' }]
						: [
								{ toolCalls: [{ id: 'capture', name: 'capture_evidence', args: {} }] },
								{ text: 'Done.' },
							],
			}),
			tools,
			...(entry === 'prepare' ? { prepareStep: prepare } : {}),
			projectId: generateProjectId(),
			...memorySession(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			workingDirectory: process.cwd(),
			agentId: 'capture-check',
			agentName: 'Capture check',
			messages: [{ role: 'user', content: 'Inspect the recorded boundary.' }],
			signal: caller.signal,
			turnConfig: {
				model: 'mock',
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				permissionMode: 'auto',
			},
		})
		expect(run.status).toBe(cancelDuringCapture ? 'cancelled' : 'completed')
		expect(returned).toBe(!cancelDuringCapture)
		expect(refused).toBe(cancelDuringCapture)
		await expect(capture!()).rejects.toThrow(
			cancelDuringCapture
				? 'cancelled'
				: entry === 'tool'
					? 'invocation has settled'
					: 'active invocation',
		)
	},
)

it.each(['nested', 'local'] as const)(
	'limits %s capture cancellation to its owner',
	async (mode) => {
		const local = new AbortController()
		let receivedSignal: AbortSignal | undefined
		const captureTextEvidence = vi.fn(async (_maxReadBytes?: number, signal?: AbortSignal) => {
			receivedSignal = signal
			if (captureTextEvidence.mock.calls.length === 1) local.abort(new Error('only this read'))
			return undefined
		})
		let childCapture: ToolContext['captureSessionEvidence']
		let childRefused = false
		let parentRead = false
		const tools = new ToolRegistry()
		tools.register({
			name: 'child',
			description: 'Read inside a nested dispatch.',
			inputSchema: z.object({}),
			maxRetries: 0,
			execute: async (_input, context) => {
				childCapture = context.captureSessionEvidence
				try {
					await childCapture!()
				} catch {
					childRefused = true
				}
				return { success: true, output: 'Child observed cancellation.' }
			},
		})
		tools.register({
			name: 'parent',
			description: 'Keep working after one read is cancelled.',
			inputSchema: z.object({}),
			maxRetries: 0,
			execute: async (_input, context) => {
				if (mode === 'nested') {
					await context.dispatchTool!('child', {}, { signal: local.signal })
					await expect(childCapture!()).rejects.toThrow('only this read')
				} else {
					await expect(context.captureSessionEvidence!(1024, local.signal)).rejects.toThrow(
						'only this read',
					)
					await expect(context.captureSessionEvidence!(1024, local.signal)).rejects.toThrow(
						'only this read',
					)
				}
				expect(receivedSignal?.aborted).toBe(true)
				expect(captureTextEvidence).toHaveBeenCalledTimes(1)
				expect(context.abortSignal.aborted).toBe(false)
				await context.captureSessionEvidence!()
				parentRead = true
				return { success: true, output: 'Parent still owns its evidence read.' }
			},
		})
		interceptCapture(captureTextEvidence)
		const run = await drainQuery({
			turnId: generateTurnId(),
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ id: 'parent', name: 'parent', args: {} }] }, { text: 'Done.' }],
			}),
			tools,
			projectId: generateProjectId(),
			...memorySession(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			workingDirectory: process.cwd(),
			agentId: 'capture-check',
			agentName: 'Capture check',
			messages: [{ role: 'user', content: 'Cancel one read, then continue.' }],
			turnConfig: {
				model: 'mock',
				maxIterations: 3,
				tokenBudget: 100_000,
				timeoutMs: 10_000,
				permissionMode: 'auto',
			},
		})
		expect(run.status).toBe('completed')
		expect(parentRead).toBe(true)
		if (mode === 'nested') expect(childRefused).toBe(true)
		expect(captureTextEvidence).toHaveBeenCalledTimes(2)
	},
)
