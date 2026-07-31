import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { PrepareStep } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { drainQuery } from '../index.js'

/**
 * `stopWhen` let a run decide TO STOP from what its steps produced. This
 * is the other half — deciding how the next step should be SHAPED.
 *
 * Without it the tool surface and the model are fixed at `query()` time,
 * so a phased agent (research with search tools, then write with file
 * tools, then verify with a cheaper model) had to be three separate runs,
 * each starting blind to the last one's context.
 */

const dirs: string[] = []

afterEach(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
	dirs.length = 0
})

function tool(name: string, calls: string[]): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		execute: () => {
			calls.push(name)
			return Promise.resolve({ success: true, output: `${name} ok` })
		},
	} as unknown as ToolDefinition
}

async function run(opts: {
	turns: NonNullable<ConstructorParameters<typeof MockLLMProvider>[0]>['turns']
	prepareStep?: PrepareStep
	toolNames?: string[]
}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-prepare-'))
	dirs.push(workingDirectory)

	const calls: string[] = []
	const tools = new ToolRegistry()
	for (const name of opts.toolNames ?? ['search', 'write_file']) {
		tools.register(tool(name, calls))
	}

	const provider = new MockLLMProvider({ turns: opts.turns })
	const result = await drainQuery({
		provider,
		tools,
		runConfig: {
			model: 'base-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 6,
			maxResponseTokens: 256,
			temperature: 0.5,
		},
		agentId: 'agent_p',
		agentName: 'Phased',
		messages: [createUserMessage('do the work')],
		workingDirectory,
		sessionId: 'ses_p' as SessionId,
		threadId: 'thd_p' as ThreadId,
		projectId: 'prj_p' as ProjectId,
		tenantId: 'tnt_p' as TenantId,
		...(opts.prepareStep ? { prepareStep: opts.prepareStep } : {}),
	})

	return { result, provider, calls }
}

describe('prepareStep shapes each step', () => {
	it('narrows the tool surface for a phase', async () => {
		const { provider } = await run({
			turns: [{ text: 'done' }],
			prepareStep: () => ({ activeTools: ['search'] }),
		})

		const sent = provider.requests[0]?.tools ?? []
		expect(sent.map((t) => t.function.name)).toEqual(['search'])
	})

	it('can change the surface between steps', async () => {
		// The whole point: research first, then write.
		const { provider } = await run({
			turns: [{ toolCalls: [{ name: 'search', args: {} }] }, { text: 'written' }],
			prepareStep: ({ stepNumber }) => ({
				activeTools: stepNumber === 1 ? ['search'] : ['write_file'],
			}),
		})

		expect(provider.requests[0]?.tools?.map((t) => t.function.name)).toEqual(['search'])
		expect(provider.requests[1]?.tools?.map((t) => t.function.name)).toEqual(['write_file'])
	})

	it('does NOT touch tool_choice', async () => {
		// Anthropic has no `allowed_tools`, and moving `tool_choice`
		// invalidates cached MESSAGE blocks too — a strictly worse trade for
		// the same effect.
		const { provider } = await run({
			turns: [{ text: 'done' }],
			prepareStep: () => ({ activeTools: ['search'] }),
		})
		expect(provider.requests[0]?.toolChoice).toBeUndefined()
	})

	it('overrides the model for one step', async () => {
		const { provider } = await run({
			turns: [{ toolCalls: [{ name: 'search', args: {} }] }, { text: 'done' }],
			prepareStep: ({ stepNumber }) => (stepNumber === 2 ? { model: 'cheap-model' } : undefined),
		})

		expect(provider.requests[0]?.model).toBe('base-model')
		expect(provider.requests[1]?.model).toBe('cheap-model')
	})

	it('overrides sampling for one step', async () => {
		const { provider } = await run({
			turns: [{ text: 'done' }],
			prepareStep: () => ({ temperature: 0, maxResponseTokens: 64 }),
		})

		expect(provider.requests[0]?.temperature).toBe(0)
		expect(provider.requests[0]?.maxTokens).toBe(64)
	})

	it('adds step guidance to the REQUEST without retaining it in history', async () => {
		// Pushing it onto the run would accumulate one stale instruction per
		// iteration.
		const { provider, result } = await run({
			turns: [{ toolCalls: [{ name: 'search', args: {} }] }, { text: 'done' }],
			prepareStep: ({ stepNumber }) =>
				stepNumber === 1 ? { system: 'PHASE: research only' } : undefined,
		})

		const first = provider.requests[0]?.messages ?? []
		expect(JSON.stringify(first)).toContain('PHASE: research only')

		// Not in the second request, and not in the run's history.
		expect(JSON.stringify(provider.requests[1]?.messages ?? [])).not.toContain('PHASE:')
		expect(JSON.stringify(result.messages)).not.toContain('PHASE:')
	})

	it('sees the steps produced so far', async () => {
		const seen: number[] = []
		await run({
			turns: [{ toolCalls: [{ name: 'search', args: {} }] }, { text: 'done' }],
			prepareStep: ({ stepNumber, steps, messages }) => {
				seen.push(steps.length)
				expect(stepNumber).toBe(seen.length)
				expect(messages.length).toBeGreaterThan(0)
				return undefined
			},
		})

		// Step 1 has nothing behind it; step 2 can read step 1's result.
		expect(seen).toEqual([0, 1])
	})
})

describe('prepareStep is safe to get wrong', () => {
	it('fails OPEN — a throwing hook does not kill a healthy run', async () => {
		// Same reasoning as `stopWhen`, and deliberately opposite to a
		// guardrail: nothing unsafe gets through when step shaping is
		// skipped.
		const { result, provider } = await run({
			turns: [{ text: 'still fine' }],
			prepareStep: () => {
				throw new Error('phase table missing')
			},
		})

		expect(result.result).toBe('still fine')
		expect(result.stopReason).toBe('end_turn')
		// Fell back to the run's full surface.
		expect(provider.requests[0]?.tools).toHaveLength(2)
	})

	it('ignores tools that are not registered rather than failing the run', async () => {
		// A phase list that outlives a tool rename should narrow the
		// surface, not kill the agent mid-run.
		const { provider, result } = await run({
			turns: [{ text: 'done' }],
			prepareStep: () => ({ activeTools: ['search', 'renamed_away'] }),
		})

		expect(provider.requests[0]?.tools?.map((t) => t.function.name)).toEqual(['search'])
		expect(result.stopReason).toBe('end_turn')
	})

	it('returning nothing is the same as having no hook', async () => {
		const hook = vi.fn<PrepareStep>(() => undefined)
		const { provider } = await run({ turns: [{ text: 'done' }], prepareStep: hook })

		expect(hook).toHaveBeenCalled()
		expect(provider.requests[0]?.model).toBe('base-model')
		expect(provider.requests[0]?.temperature).toBe(0.5)
		expect(provider.requests[0]?.tools).toHaveLength(2)
	})

	it('an empty activeTools list really does remove every tool', async () => {
		// Distinguished from "no opinion" — `[]` is a decision.
		const { provider } = await run({
			turns: [{ text: 'done' }],
			prepareStep: () => ({ activeTools: [] }),
		})
		expect(provider.requests[0]?.tools).toBeUndefined()
	})

	it('an async hook is awaited', async () => {
		const { provider } = await run({
			turns: [{ text: 'done' }],
			prepareStep: async () => {
				await Promise.resolve()
				return { model: 'async-model' }
			},
		})
		expect(provider.requests[0]?.model).toBe('async-model')
	})
})
