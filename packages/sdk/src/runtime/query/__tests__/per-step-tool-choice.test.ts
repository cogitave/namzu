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
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * Forcing a tool is the one step-shaping knob that can hang an agent.
 *
 * A forced choice that PERSISTS makes the model call a tool, read the
 * result, and be forced again — forever. The peer SDK that puts
 * `tool_choice` on persistent model settings carries three moving parts to
 * undo that: a tool-use tracker, an opt-out flag, and a reset applied at
 * two separate call sites. Its flag defaults to on precisely because
 * turning it off hangs the agent.
 *
 * Putting the knob on `prepareStep` removes the failure instead of
 * managing it: the next step is prepared from scratch, so a force cannot
 * outlive the step that asked for it. There is no flag to get wrong.
 */

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

async function mkWorkdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-tool-choice-'))
	workdirs.push(dir)
	return dir
}

function registerEcho(tools: ToolRegistry): void {
	tools.register({
		name: 'echo',
		description: 'Echo the text back.',
		inputSchema: z.object({ text: z.string().optional() }),
		execute: async () => ({ success: true, output: 'ok' }),
	})
}

async function baseParams(provider: MockLLMProvider, tools: ToolRegistry) {
	return {
		provider,
		tools,
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		agentId: 'agent_tc',
		agentName: 'Tool Choice Agent',
		workingDirectory: await mkWorkdir(),
		sessionId: 'ses_tc' as SessionId,
		threadId: 'thd_tc' as ThreadId,
		projectId: 'prj_tc' as ProjectId,
		tenantId: 'tnt_tc' as TenantId,
		messages: [createUserMessage('go')],
	}
}

describe('a step can force the model to call a tool', () => {
	it('puts the caller choice on that step request', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const tools = new ToolRegistry()
		registerEcho(tools)

		await drainQuery({
			...(await baseParams(provider, tools)),
			prepareStep: () => ({ toolChoice: 'required' as const }),
		})

		expect(provider.requests.at(0)?.toolChoice).toBe('required')
	})

	it('carries a named function through unchanged', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const tools = new ToolRegistry()
		registerEcho(tools)

		await drainQuery({
			...(await baseParams(provider, tools)),
			prepareStep: () => ({
				toolChoice: { type: 'function' as const, function: { name: 'echo' } },
			}),
		})

		expect(provider.requests.at(0)?.toolChoice).toEqual({
			type: 'function',
			function: { name: 'echo' },
		})
	})

	it('leaves the request alone when no step asks', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const tools = new ToolRegistry()
		registerEcho(tools)

		await drainQuery(await baseParams(provider, tools))

		expect(provider.requests.at(0)?.toolChoice).toBeUndefined()
	})

	it('says nothing when there are no tools to choose between', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })

		await drainQuery({
			...(await baseParams(provider, new ToolRegistry())),
			prepareStep: () => ({ toolChoice: 'required' as const }),
		})

		// `tool_choice` alongside an absent tool list is rejected by the
		// providers, so a forced choice with nothing registered has to drop.
		expect(provider.requests.at(0)?.toolChoice).toBeUndefined()
	})
})

/**
 * NOT covered here, and deliberately not faked: the forced-final turn takes
 * precedence over a step's choice (`forceFinalize` wins in
 * `iteration/index.ts`), so a budget-exhausted run can still stop asking
 * for tools and answer. Reaching that branch needs the guard to raise a
 * budget warning, which needs real usage the mock provider does not report.
 * The precedence is implemented and read in review; it is not pinned.
 */
describe('a forced choice cannot outlive the step that asked for it', () => {
	it('applies to the named step only, leaving later steps free', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] },
				{ text: 'finished' },
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		await drainQuery({
			...(await baseParams(provider, tools)),
			// Only the first step is forced. Without per-step scoping this
			// would keep forcing and the run would never reach a text answer.
			prepareStep: ({ stepNumber }) =>
				stepNumber === 1 ? { toolChoice: 'required' as const } : {},
		})

		expect(provider.requests.at(0)?.toolChoice).toBe('required')
		expect(provider.requests.at(1)?.toolChoice).toBeUndefined()
	})

	it('a run whose every step forces a tool still ends, bounded by the loop', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] },
				{ toolCalls: [{ id: 'c2', name: 'echo', rawArguments: '{}' }] },
				{ text: 'finished' },
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...(await baseParams(provider, tools)),
			prepareStep: () => ({ toolChoice: 'required' as const }),
		})

		// The knob cannot hang a run on its own: the iteration cap is still
		// the backstop, and it settles rather than spinning.
		expect(['completed', 'failed']).toContain(run.status)
	})
})
