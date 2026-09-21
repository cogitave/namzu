import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { DefaultPathBuilder } from '../../session/workspace/path-builder.js'
import type { ReactiveAgentConfig } from '../../types/agent/reactive.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { ReactiveAgent } from '../ReactiveAgent.js'

/**
 * `pruneKeepLast` reaches a run started through an agent.
 *
 * It existed only on the raw kernel's run config, and `ReactiveAgent` builds
 * that config from a hand-listed literal, so a host that bounds its own runs
 * could not bound a delegated child's: the child kept every checkpoint.
 */

const scope = {
	sessionId: '3cdbce22-edce-4f36-aec7-644f29f72a87' as SessionId,
	topicId: 'd3df3586-e05b-4c3c-9e82-9381af89004f' as TopicId,
	projectId: '1ec83217-ec48-42c8-acfb-0a37c43c4872' as ProjectId,
	tenantId: '46200af0-33d2-4831-89b5-dfa19e427570' as TenantId,
}

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function checkpointsLeft(pruneKeepLast?: number): Promise<number> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-agent-retention-'))
	dirs.push(root)
	const tools = new ToolRegistry()
	tools.register({
		name: 'probe',
		description: 'probe',
		inputSchema: z.object({ n: z.number() }),
		isReadOnly: () => true,
		execute: async ({ n }) => ({ success: true, output: `probed ${n}` }),
	})
	const turns = Array.from({ length: 6 }, (_, n) => ({
		toolCalls: [{ id: `c${n}`, name: 'probe', args: { n } }],
	}))
	const agent = new ReactiveAgent({
		id: 'retention',
		name: 'Retention',
		version: '1',
		category: 'test',
		description: 'checkpoint retention reachability',
	})
	const pathBuilder = new DefaultPathBuilder(join(root, 'state'))
	const result = await agent.run(
		{ messages: [createUserMessage('probe six times')], workingDirectory: root },
		{
			provider: new MockLLMProvider({ turns: [...turns, { text: 'done' }] }),
			tools,
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 10_000,
			maxIterations: 10,
			pathBuilder,
			...(pruneKeepLast !== undefined ? { pruneKeepLast } : {}),
			...scope,
		} satisfies ReactiveAgentConfig,
	)
	const dir = join(pathBuilder.runDir(scope.projectId, scope.sessionId, result.runId), 'checkpoints')
	return (await readdir(dir)).filter((name) => name.endsWith('.json')).length
}

it('bounds the checkpoints of a run started through ReactiveAgent', async () => {
	expect(await checkpointsLeft()).toBeGreaterThan(4)
	expect(await checkpointsLeft(2)).toBeLessThanOrEqual(2)
})
