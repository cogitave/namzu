import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import type { ReactiveAgentConfig } from '../../types/agent/reactive.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { ReactiveAgent } from '../ReactiveAgent.js'

/**
 * `ReactiveAgent` is the entry point consumers actually use — it is what
 * `AgentManager` spawns and what the estate's own applications call. It
 * forwarded none of the loop-control seams on `QueryParams`, so a per-tool
 * deadline, a retry policy, a guardrail or a stop condition was reachable
 * only by dropping to `query()` and rebuilding the run wiring by hand.
 *
 * A feature a consumer cannot reach is a feature that does not exist for
 * them, so these assert reachability rather than behavior — the behavior
 * already has its own tests one layer down.
 */

const agent = () =>
	new ReactiveAgent({
		id: 'reach',
		name: 'Reach',
		version: '1.0.0',
		category: 'test',
		description: 'reachability probe',
	})

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function fsTool(name: string): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		category: 'filesystem',
		permissions: ['file_read'],
		execute: () => Promise.resolve({ success: true, output: 'ok' }),
	} as unknown as ToolDefinition
}

async function baseConfig(provider: MockLLMProvider, tools: ToolRegistry) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-reach-'))
	dirs.push(workingDirectory)
	return {
		workingDirectory,
		config: {
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 10_000,
			maxIterations: 4,
			provider,
			tools,
			sessionId: 'ses_r' as SessionId,
			topicId: 'top_r' as ThreadId,
			projectId: 'prj_r' as ProjectId,
			tenantId: 'tnt_r' as TenantId,
		} satisfies ReactiveAgentConfig,
	}
}

describe('ReactiveAgent forwards the loop-control seams', () => {
	it('reaches an output guardrail', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'raw answer' }] })
		const { workingDirectory, config } = await baseConfig(provider, new ToolRegistry())

		const result = await agent().run(
			{ messages: [createUserMessage('go')], workingDirectory },
			{ ...config, outputGuardrails: [() => ({ action: 'rewrite', output: 'cleaned' })] },
		)

		expect(result.result).toBe('cleaned')
	})

	it('reaches a stop condition', async () => {
		const provider = new MockLLMProvider({
			turns: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
		})
		const { workingDirectory, config } = await baseConfig(provider, new ToolRegistry())

		await agent().run(
			{ messages: [createUserMessage('go')], workingDirectory },
			{ ...config, stopWhen: () => true },
		)

		expect(provider.requests).toHaveLength(1)
	})

	it('reaches prepareStep', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const { workingDirectory, config } = await baseConfig(provider, new ToolRegistry())

		await agent().run(
			{ messages: [createUserMessage('go')], workingDirectory },
			{ ...config, prepareStep: () => ({ model: 'swapped-model' }) },
		)

		expect(provider.requests[0]?.model).toBe('swapped-model')
	})

	it('reaches beforeStep, and a refusal costs no provider call', async () => {
		// The reachability half. `beforeStep` is consulted deep in the
		// iteration loop, and a config field that never arrives there is a
		// hook a host configures and nothing honours — which reads exactly
		// like a hook that decided not to fire.
		const provider = new MockLLMProvider({ turns: [{ text: 'never' }] })
		const { workingDirectory, config } = await baseConfig(provider, new ToolRegistry())

		const result = await agent().run(
			{ messages: [createUserMessage('go')], workingDirectory },
			{ ...config, beforeStep: () => ({ reason: 'tenant suspended' }) },
		)

		expect(provider.requests).toHaveLength(0)
		expect(result.stopReason).toBe('step_refused')
	})

	it('reaches an input guardrail, so a refusal costs nothing', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'never' }] })
		const { workingDirectory, config } = await baseConfig(provider, new ToolRegistry())

		const result = await agent().run(
			{ messages: [createUserMessage('go')], workingDirectory },
			{ ...config, inputGuardrails: [() => ({ action: 'block', reason: 'no' })] },
		)

		expect(provider.requests).toHaveLength(0)
		expect(result.stopReason).toBe('input_guardrail')
	})

	it('reaches onStepFinish', async () => {
		// A step is recorded per TOOL-CALLING turn: a text-only turn breaks
		// out of the loop before `recordStep` runs, so drive one tool call.
		// (That the final text turn produces no step is worth revisiting on
		// its own — it is a real hole in `Run.steps` — but changing loop
		// semantics is not what this test is for.)
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'read_file', args: {} }] }, { text: 'done' }],
		})
		const tools = new ToolRegistry()
		tools.register(fsTool('read_file'))
		const { workingDirectory, config } = await baseConfig(provider, tools)
		const onStepFinish = vi.fn()

		await agent().run(
			{ messages: [createUserMessage('go')], workingDirectory },
			{ ...config, onStepFinish },
		)

		expect(onStepFinish).toHaveBeenCalled()
	})
})

describe('the <env> block keys on what a tool declares, not its name', () => {
	it('emits it for a filesystem tool that is not one of the four built-in names', async () => {
		// A host registering `read_file` with `category: 'filesystem'` and
		// `permissions: ['file_read']` used to get NO env block, so the model
		// was never told its working directory and the host hand-encoded
		// paths into the system prompt instead.
		const tools = new ToolRegistry()
		tools.register(fsTool('read_file'))
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const { workingDirectory, config } = await baseConfig(provider, tools)

		await agent().run({ messages: [createUserMessage('go')], workingDirectory }, config)

		const system = (provider.requests[0]?.messages ?? [])
			.filter((m) => m.role === 'system')
			.map((m) => m.content)
			.join('\n')
		expect(system).toContain(workingDirectory)
	})

	it('still says nothing when no tool touches the filesystem', async () => {
		const tools = new ToolRegistry()
		tools.register({
			name: 'add',
			description: 'add numbers',
			inputSchema: z.object({}),
			category: 'analysis',
			execute: () => Promise.resolve({ success: true, output: '2' }),
		} as unknown as ToolDefinition)
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const { workingDirectory, config } = await baseConfig(provider, tools)

		await agent().run({ messages: [createUserMessage('go')], workingDirectory }, config)

		const system = (provider.requests[0]?.messages ?? [])
			.filter((m) => m.role === 'system')
			.map((m) => m.content)
			.join('\n')
		expect(system).not.toContain(workingDirectory)
	})
})

describe('a provider is not handed the live run array', () => {
	it('what a driver retained at turn 1 still reads as turn 1 afterwards', async () => {
		// `runMgr.messages` is the live array and the loop pushes onto it
		// after the call returns, so a driver that retained its input watched
		// it grow new turns underneath. A capture provider in the estate
		// recorded every turn as identical to the last for exactly this.
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'read_file', args: {} }] }, { text: 'done' }],
		})
		// Retain the REFERENCE, exactly as a logging or caching driver would,
		// and read it only after the whole run has finished. Reading it
		// during the call proves nothing — the divergence appears later.
		const retained: (readonly unknown[])[] = []
		const original = provider.chatStream.bind(provider)
		provider.chatStream = (params) => {
			retained.push(params.messages)
			return original(params)
		}

		const tools = new ToolRegistry()
		tools.register(fsTool('read_file'))
		const { workingDirectory, config } = await baseConfig(provider, tools)

		await agent().run({ messages: [createUserMessage('go')], workingDirectory }, config)

		expect(retained.length).toBeGreaterThanOrEqual(2)
		// Two distinct arrays, not one aliased one.
		expect(retained[0]).not.toBe(retained[1])
		// And turn 1's copy still describes turn 1. With the live array both
		// entries had grown to the final length by now.
		expect(retained[0]?.length).toBeLessThan(retained[1]?.length as number)
	})

	it('reaches a tool deny list, so a direct run can be narrowed too', async () => {
		// `deniedTools` was added for delegation — a supervisor scoping a
		// child — and lands on `BaseAgentConfig`, which means a host running
		// an agent DIRECTLY has it too. Reachable there is not the same
		// claim as reachable through `AgentManager`, and this file exists
		// because that gap is where seams go missing: `query()` honouring a
		// field the class never forwards is a field no consumer can use.
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const seen: string[][] = []
		const original = provider.chatStream.bind(provider)
		provider.chatStream = (params) => {
			seen.push(
				((params.tools ?? []) as { function: { name: string } }[])
					.map((t) => t.function.name)
					.sort(),
			)
			return original(params)
		}

		const tools = new ToolRegistry()
		tools.register(fsTool('read_file'))
		tools.register(fsTool('write_file'))
		const { workingDirectory, config } = await baseConfig(provider, tools)

		await agent().run({ messages: [createUserMessage('go')], workingDirectory }, {
			...config,
			deniedTools: ['write_file'],
		} satisfies ReactiveAgentConfig)

		expect(seen[0]).toEqual(['read_file'])
	})
})
