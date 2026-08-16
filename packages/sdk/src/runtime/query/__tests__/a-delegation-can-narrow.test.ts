import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A supervisor could not hand a child a narrower tool set.
 *
 * `allowedTools` lived on `QueryParams` and on `ToolContext` and nowhere
 * on the path a delegation takes, so a read-only research subtask handed
 * to an agent whose definition also grants `write` and `bash` ran with all
 * of them.
 *
 * A deny list rather than an allow list, because the delegating side does
 * not know what the child has. Enumerating the agent's whole tool set to
 * remove one from it pins that list against an agent that later gains a
 * tool — silently, and in the direction of MORE access.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function tool(name: string) {
	return defineTool({
		name,
		description: name,
		inputSchema: z.object({}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async () => ({ success: true, output: `${name} ran` }),
	})
}

function registry(): ToolRegistry {
	const r = new ToolRegistry()
	for (const name of ['read', 'write', 'bash']) r.register(tool(name))
	return r
}

/** Records the tool list every request carried. */
class RecordingProvider extends MockLLMProvider {
	toolLists: string[][] = []
	constructor(turns: unknown[]) {
		super({ turns: turns as never })
	}
	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.toolLists.push(
			((params.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name).sort(),
		)
		yield* super.chatStream(params)
	}
}

async function run(opts: {
	readonly deniedTools?: readonly string[]
	readonly allowedTools?: readonly string[]
	readonly turns?: unknown[]
}): Promise<{ requests: string[][]; outputs: string[] }> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-narrow-'))
	dirs.push(workingDirectory)
	const provider = new RecordingProvider(opts.turns ?? [{ text: 'done' }])

	const result = await drainQuery({
		provider,
		tools: registry(),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 3 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_n' as SessionId,
		topicId: 'top_n' as TopicId,
		projectId: 'prj_n' as ProjectId,
		tenantId: 'tnt_n' as TenantId,
		...(opts.deniedTools ? { deniedTools: [...opts.deniedTools] } : {}),
		...(opts.allowedTools ? { allowedTools: [...opts.allowedTools] } : {}),
	})

	return {
		requests: provider.toolLists,
		outputs: result.messages
			.filter((m) => m.role === 'tool' && typeof m.content === 'string')
			.map((m) => m.content as string),
	}
}

const call = (name: string) => ({
	toolCalls: [{ id: 't1', name, args: {} }],
	finishReason: 'tool_calls' as const,
})

describe('a delegation can narrow what a child may use', () => {
	it('removes a denied tool from the request, with no allow-list in play', () => {
		// The ordinary shape of a delegated child: it names no allow-list, so
		// the subtraction has to resolve against the registry. Applying the
		// deny to an empty list would deny nothing and pass a naive test.
		return run({ deniedTools: ['bash'] }).then(({ requests }) => {
			expect(requests[0]).toEqual(['read', 'write'])
		})
	})

	it('is ENFORCED, not presentational: the denied tool cannot be called by name', async () => {
		// The lesson the runtime already records for step-level narrowing.
		// Narrowing only the request shows the model fewer tools and lets it
		// call any of them by name, which is a restriction that reads as one
		// and is not one.
		const { outputs } = await run({
			deniedTools: ['bash'],
			turns: [call('bash'), { text: 'done' }],
		})

		expect(outputs[0]).not.toContain('bash ran')
	})

	it('narrows an existing allow-list rather than replacing it', async () => {
		const { requests } = await run({ allowedTools: ['read', 'write'], deniedTools: ['write'] })

		expect(requests[0]).toEqual(['read'])
	})

	it('treats a name the run never had as a no-op', async () => {
		// The result is still narrower, and refusing would make a caller's
		// deny list depend on which agent it happened to be talking to.
		const { requests } = await run({ deniedTools: ['a_tool_that_does_not_exist'] })

		expect(requests[0]).toEqual(['bash', 'read', 'write'])
	})

	it('changes nothing for a run that denies nothing', async () => {
		// The absent case must behave exactly as it did before this existed.
		//
		// The implementation additionally short-circuits so it does not
		// resolve the registry into an explicit list when nothing is denied
		// — that avoids pinning the tool set against later registration, and
		// this test CANNOT see it: both paths produce the same request here.
		// Said rather than implied, because a comment claiming a property no
		// assertion covers is how a check comes to be trusted for something
		// it never did.
		const { requests } = await run({})

		expect(requests[0]).toEqual(['bash', 'read', 'write'])
	})
})
