import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * Narrowing a step has to narrow what RUNS, not only what is offered.
 *
 * `prepareStep.activeTools` says "restrict which tools the model may call
 * this step, by name", and for a while it did nothing of the sort: it chose
 * which schemas went into the request, was copied into the tool context, and
 * was read by nobody on the execution path. A model that named a withheld
 * tool had it run — and a model does name one, from a repeated call earlier
 * in the context, from a gateway carrying its own tool list, or from a
 * replayed cache prefix.
 *
 * These tests call the withheld tool deliberately, which is the only way to
 * tell an enforced restriction from a presentational one. Every existing test
 * asked the model nicely and so could not have caught this.
 */

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

let danger = 0

const readOnly = defineTool({
	name: 'read_only',
	description: 'observes',
	inputSchema: z.object({}),
	category: 'analysis',
	permissions: [],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	async execute() {
		return { success: true, output: 'observed' }
	},
})

const dangerous = defineTool({
	name: 'danger',
	description: 'mutates',
	inputSchema: z.object({}),
	category: 'custom',
	permissions: [],
	readOnly: false,
	destructive: true,
	concurrencySafe: false,
	async execute() {
		danger += 1
		return { success: true, output: 'the withheld tool ran' }
	},
})

/** Calls whichever tool it is told to, then answers. */
class NamesTool implements LLMProvider {
	readonly id = 'names-tool'
	readonly name = 'Names Tool Provider'
	calls = 0
	offered: string[][] = []

	constructor(private readonly toolName: string) {}

	async *chatStream(params: {
		tools?: { function: { name: string } }[]
	}): AsyncIterable<StreamChunk> {
		this.calls += 1
		this.offered.push((params.tools ?? []).map((t) => t.function.name))

		if (this.calls === 1) {
			yield {
				id: 'msg_1',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: 'toolu_1',
							type: 'function',
							function: { name: this.toolName, arguments: '{}' },
						},
					],
				},
			}
			yield { id: 'msg_1', delta: {}, finishReason: 'tool_calls', usage: ZERO_USAGE }
			return
		}

		yield { id: 'msg_2', delta: { content: 'done' } }
		yield { id: 'msg_2', delta: {}, finishReason: 'stop', usage: ZERO_USAGE }
	}
}

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
	danger = 0
})

async function run(opts: {
	names: string
	allowedTools?: string[]
	activeTools?: string[]
}): Promise<{ offered: string[][]; output: string }> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-allow-'))
	workdirs.push(workingDirectory)

	const tools = new ToolRegistry()
	tools.register(readOnly)
	tools.register(dangerous)

	const provider = new NamesTool(opts.names)
	let output = ''

	await drainQuery(
		{
			provider,
			tools,
			...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
			...(opts.activeTools
				? { prepareStep: () => ({ activeTools: opts.activeTools as string[] }) }
				: {}),
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('go')],
			workingDirectory,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
			sessionId: 'ses_allow' as SessionId,
			threadId: 'thd_allow' as ThreadId,
			projectId: 'prj_allow' as ProjectId,
			tenantId: 'tnt_allow' as TenantId,
		},
		(event) => {
			if (event.type === 'tool_completed') output += event.result ?? ''
		},
	)

	return { offered: provider.offered, output }
}

describe('a narrowed step narrows what can run, not just what is shown', () => {
	it('refuses a tool the step withheld, even when the model names it', async () => {
		const { offered, output } = await run({ names: 'danger', activeTools: ['read_only'] })

		// The request really was narrowed — otherwise this test proves nothing
		// about enforcement, only about the model's manners.
		expect(offered[0]).toEqual(['read_only'])
		// And the call was refused rather than executed.
		expect(danger, 'the withheld tool executed').toBe(0)
		expect(output).toContain('not available on this step')
	})

	it('refuses a tool outside the run-level list too', async () => {
		const { output } = await run({ names: 'danger', allowedTools: ['read_only'] })

		expect(danger).toBe(0)
		expect(output).toContain('not available on this step')
	})

	it('still runs a tool that is on the list', async () => {
		const { output } = await run({ names: 'read_only', activeTools: ['read_only'] })

		expect(output).toContain('observed')
	})

	it('leaves an unnarrowed run alone', async () => {
		// Absent means unrestricted. A run that never narrows anything must not
		// suddenly start refusing its own tools.
		const { output } = await run({ names: 'danger' })

		expect(danger).toBe(1)
		expect(output).toContain('the withheld tool ran')
	})

	it('treats an empty list as "nothing", not as "no restriction"', async () => {
		// The fail-open reading this codebase has already been bitten by once,
		// in the delegate roster: an empty allow-list IS the answer, and
		// degrading it to "unrestricted" is how a closed list becomes open.
		const { output } = await run({ names: 'danger', activeTools: [] })

		expect(danger).toBe(0)
		expect(output).toContain('(none)')
	})
})
