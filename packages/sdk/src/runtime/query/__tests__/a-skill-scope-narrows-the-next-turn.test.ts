import { describe, expect, it, vi } from 'vitest'

import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolContext, ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

/**
 * `allowed-tools` as a restriction rather than as advice.
 *
 * It was parsed, stored on `SkillMetadata`, rendered into the prompt as
 * `<allowed_tools>…</allowed_tools>` and read by nothing — a declaration
 * the model could decline. These pin the two properties that make it real:
 * the scope INTERSECTS what the turn already allows, and it lands on the
 * NEXT batch rather than retroactively refusing the calls the model issued
 * alongside the skill it loaded.
 */

const RUN_ID = 'run_scope' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

/** Records the `allowedTools` each call was dispatched under. */
function recordingRegistry(seen: (readonly string[] | undefined)[]): ToolRegistryContract {
	return {
		register: vi.fn(),
		unregister: vi.fn(),
		execute: vi.fn(async (_name: string, _input: unknown, context: ToolContext) => {
			seen.push(context.allowedTools)
			return { success: true, output: 'ok' }
		}),
		get: vi.fn(() => undefined),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		getAvailability: vi.fn(),
	} as unknown as ToolRegistryContract
}

const call = (id: string, name: string) => ({
	id,
	type: 'function' as const,
	function: { name, arguments: '{}' },
})

const batch = (...names: string[]): ChatCompletionResponse =>
	({
		message: {
			role: 'assistant',
			content: null,
			toolCalls: names.map((name, i) => call(`c${i}`, name)),
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	}) as ChatCompletionResponse

function executorWith(
	seen: (readonly string[] | undefined)[],
	allowedTools?: readonly string[],
): ToolExecutor {
	return new ToolExecutor(
		{
			tools: recordingRegistry(seen),
			runId: RUN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			...(allowedTools ? { allowedTools } : {}),
		},
		new ActivityStore(RUN_ID, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
		async (_e: RunEvent) => {},
		makeLogger(),
	)
}

/**
 * Adopt a scope the way the `skill` tool does: from inside a batch, through
 * the context the executor handed it.
 *
 * Wrapping the registry rather than registering a real tool, because what
 * is under test is the executor's bookkeeping and not the tool's parsing —
 * that half is pinned next to the tool. The wrapper only adopts and
 * delegates; the recording stays in the registry it wraps, so a call is
 * counted once.
 */
async function adoptDuring(
	executor: ToolExecutor,
	response: ChatCompletionResponse,
	scope: { skill: string; allowedTools: readonly string[] },
): Promise<void> {
	const tools = (executor as unknown as { config: { tools: ToolRegistryContract } }).config.tools
	const original = tools.execute.bind(tools)
	;(tools as { execute: unknown }).execute = async (
		name: string,
		input: unknown,
		context: ToolContext,
	) => {
		context.adoptSkillScope?.(scope)
		return await (original as (...a: unknown[]) => Promise<unknown>)(name, input, context)
	}
	await executor.executeBatch(response)
	;(tools as { execute: unknown }).execute = original
}

describe('a scope adopted mid-batch does not refuse its own batch', () => {
	it('leaves the sibling calls under the old scope', async () => {
		// The model chose that batch under the old scope. Refusing half of it
		// teaches nothing except that tools fail at random.
		//
		// This passes today for a reason weaker than the one it states, and
		// that is written down rather than hidden: `buildToolContext()` runs
		// once per batch, so every call already shares one `allowedTools`
		// array computed before any of them could adopt. Deleting the
		// executor's `adoptedInBatch` comparison leaves this test green — the
		// mutation survives, and the guard is kept anyway for the reason its
		// own comment gives.
		const seen: (readonly string[] | undefined)[] = []
		const executor = executorWith(seen, ['skill', 'read', 'write', 'bash'])
		seen.length = 0

		await adoptDuring(executor, batch('skill', 'write'), {
			skill: 'reconcile',
			allowedTools: ['read'],
		})

		// Both calls in this batch saw the pre-adoption list.
		expect(seen).toHaveLength(2)
		for (const list of seen) expect(list).toEqual(['skill', 'read', 'write', 'bash'])
	})

	it('narrows the NEXT batch', async () => {
		const seen: (readonly string[] | undefined)[] = []
		const executor = executorWith(seen, ['skill', 'read', 'write', 'bash'])
		await adoptDuring(executor, batch('skill'), { skill: 'reconcile', allowedTools: ['read'] })
		seen.length = 0

		await executor.executeBatch(batch('read'))

		// `read` because the skill asked for it, and `skill` because a skill
		// that narrowed the model out of reaching for another skill would be a
		// one-way door.
		expect(seen[0]).toEqual(['skill', 'read'])
	})
})

describe('a scope narrows, and can never widen', () => {
	it('cannot hand back a tool the turn withheld', async () => {
		// Widening has to be unexpressible rather than discouraged: a skill
		// file is CONTENT, and content that can grant tools is a
		// privilege-escalation surface wearing the word "scope".
		const seen: (readonly string[] | undefined)[] = []
		const executor = executorWith(seen, ['skill', 'read'])
		await adoptDuring(executor, batch('skill'), {
			skill: 'reconcile',
			allowedTools: ['read', 'bash', 'write'],
		})
		seen.length = 0

		await executor.executeBatch(batch('read'))

		expect(seen[0]).toEqual(['skill', 'read'])
		expect(seen[0]).not.toContain('bash')
	})

	it('is the whole scope when the turn was unrestricted', async () => {
		// No run-level list means unrestricted, so the intersection has
		// nothing to intersect with — the scope itself becomes the list.
		const seen: (readonly string[] | undefined)[] = []
		const executor = executorWith(seen)
		await adoptDuring(executor, batch('skill'), { skill: 'reconcile', allowedTools: ['read'] })
		seen.length = 0

		await executor.executeBatch(batch('read'))

		expect([...(seen[0] ?? [])].sort()).toEqual(['read', 'skill'])
	})

	it('leaves the turn alone when nothing was adopted', async () => {
		const seen: (readonly string[] | undefined)[] = []
		const executor = executorWith(seen, ['read', 'write'])

		await executor.executeBatch(batch('read'))

		expect(seen[0]).toEqual(['read', 'write'])
	})

	it('narrows to almost nothing when the skill declared no tools', async () => {
		// `allowed-tools: ""` is an author saying this skill needs none. Only
		// `skill` survives, which is the way back out.
		const seen: (readonly string[] | undefined)[] = []
		const executor = executorWith(seen, ['skill', 'read', 'write'])
		await adoptDuring(executor, batch('skill'), { skill: 'strict', allowedTools: [] })
		seen.length = 0

		await executor.executeBatch(batch('read'))

		expect(seen[0]).toEqual(['skill'])
	})
})
