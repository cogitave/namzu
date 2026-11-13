import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionRefusedError } from '../../../compaction/hooks.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { PluginHookContext, PluginHookEvent } from '../../../types/plugin/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { compactSession } from '../compact-session.js'
import { drainQuery } from '../index.js'

/** A session's compaction fires the hooks with the trigger the call names, and a refusal keeps the log as it was. */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const scope = {
	sessionId: '3b6e9a2d-8c47-4a4e-9c88-3fbe5d5a9b01' as SessionId,
	topicId: '7c2d9e4a-1f6b-4c8d-9d2e-6b8a4c2f9e02' as TopicId,
	projectId: '5a1c8b3e-9d4f-4e6a-8c2b-1d9e6f3a5b03' as ProjectId,
	tenantId: '2d8e5c1a-6b9f-4a3d-9e1c-8f4a2b6d5c04' as TenantId,
}

async function conversation(log: InMemorySessionLog): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-idle-compaction-'))
	dirs.push(cwd)
	let history: readonly Message[] = []
	for (let turn = 1; turn <= 3; turn++) {
		const run = await drainQuery({
			provider: new MockLLMProvider({ responseText: `reply ${turn}` }),
			toolsets: [],
			messages: [...history, createUserMessage(`message ${turn}: padding so it is not tiny`)],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 4,
			},
			agentId: 'a',
			agentName: 'A',
			...scope,
		})
		history = run.messages
	}
}

async function run(trigger: 'idle' | 'manual' | undefined, refuse: boolean, instructions?: string) {
	const log = new InMemorySessionLog({ sessionId: scope.sessionId })
	await conversation(log)
	const calls: { event: PluginHookEvent; context: Partial<PluginHookContext> }[] = []
	const manager = {
		executeHooks: async (event: PluginHookEvent, context: Partial<PluginHookContext>) => {
			calls.push({ event, context })
			return refuse && event === 'pre_compact'
				? [{ action: 'skip' as const, reason: 'release freeze' }]
				: []
		},
	}
	const before = (await log.readAll()).entries.length
	const outcome = await compactSession({
		sessionId: scope.sessionId,
		locator: { log },
		...(trigger ? { trigger } : {}),
		...(instructions ? { instructions } : {}),
		hooks: { manager },
		provider: new MockLLMProvider({ responseText: 'unused' }),
		config: CompactionConfigSchema.parse({
			strategy: 'structured',
			keepRecentMessages: 2,
			clearToolResults: false,
			llmVerification: false,
		}),
	}).then(
		(result) => ({ result }),
		(error: unknown) => ({ error }),
	)
	const after = (await log.readAll()).entries.length
	return { calls, outcome, grew: after > before }
}

describe('compactSession hooks', () => {
	it('fires both hooks as manual for a plain request, with the typed words', async () => {
		const { calls, grew } = await run(undefined, false, 'keep it')
		expect(calls.map((c) => c.event)).toEqual(['pre_compact', 'post_compact'])
		expect(calls[0]?.context.compaction).toMatchObject({
			trigger: 'manual',
			instructions: 'keep it',
		})
		expect(calls[0]?.context.sessionId).toBe(scope.sessionId)
		expect(grew).toBe(true)
	})

	it('fires both hooks as auto for an idle pass', async () => {
		const { calls } = await run('idle', false)
		expect(calls.map((c) => c.context.compaction?.trigger)).toEqual(['auto', 'auto'])
	})

	it('refuses a person’s pass and appends nothing to the log', async () => {
		const { outcome, grew, calls } = await run(undefined, true)
		expect((outcome as { error?: unknown }).error).toBeInstanceOf(CompactionRefusedError)
		expect(grew).toBe(false)
		expect(calls.map((c) => c.event)).toEqual(['pre_compact'])
	})

	it('cancels an idle pass that a hook refused, without an error and without a record', async () => {
		const { outcome, grew } = await run('idle', true)
		expect(outcome).toEqual({ result: null })
		expect(grew).toBe(false)
	})
})
