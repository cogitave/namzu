import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { DiskResidentAgenda } from '../../../manager/resident/agenda.js'
import { PromptContributionRegistry } from '../../../prompt/contributions.js'
import { createResidentStepContributions } from '../../../prompt/resident-step.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import { buildResidentHistoryTools } from '../../../tools/resident-history.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs.splice(0))
})

it.each(['structured', 'sliding-window'] as const)(
	'retrieves exact past evidence through the real query after %s compaction removed it',
	async (strategy) => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-recall-compaction-'))
		dirs.push(directory)
		const tenantId = fixtureId.tenant('recall-compaction')
		const runId = fixtureId.run('recall-compaction')
		const agenda = new DiskResidentAgenda(join(directory, 'history'), {
			tenantId,
			agentKey: 'delivery',
		})
		const pursuit = await agenda.add(await agenda.create('Review evidence.'), 'Review DELTA.')
		const execution = agenda.execution(pursuit.id)
		const pending = await agenda.wake(pursuit.id, pursuit.state, 'DELTA receipt CODE-ALPHA-471.', 1)
		const settled = await execution.settle(
			await execution.claim(pending, 2),
			{ kind: 'wait', summary: 'Review unfinished.', wakeAt: null },
			3,
		)
		const snapshot = await agenda.read()
		if (!snapshot) throw new Error('Missing fixture history.')
		const source = new DiskResidentAgenda(join(directory, 'history'), {
			tenantId,
			agentKey: 'delivery',
		}).history(settled, snapshot.revision)
		const contributions = new PromptContributionRegistry()
		for (const contribution of createResidentStepContributions({
			state: settled,
			history: source.scope,
			readOnly: true,
			outputInstructions: 'Report the exact retained receipt.',
		}))
			contributions.register(contribution)
		const tools = new ToolRegistry()
		tools.register(
			buildResidentHistoryTools((context) => {
				if (context.runId !== runId) throw new Error('Wrong owner.')
				return source
			}),
		)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'search-history',
							name: 'search_resident_history',
							rawArguments: '{"query":"DELTA"}',
						},
					],
				},
				{
					toolCalls: [
						{
							id: 'read-history',
							name: 'read_resident_history',
							rawArguments: JSON.stringify({ revision: snapshot.revision, part: 1 }),
						},
					],
				},
				{ text: 'Recovered the earlier receipt.' },
			],
		})
		// The old observation is near the end of an oversized early message;
		// neither the compacted notes nor the latest resident summary retain it.
		const messages: Message[] = [
			createUserMessage(`Old analysis: ${'irrelevant context '.repeat(500)} CODE-ALPHA-471.`),
		]
		for (let index = 0; index < 18; index++) {
			messages.push(createUserMessage(`Investigation ${index}: ${'older material '.repeat(500)}`))
			messages.push(createAssistantMessage(`Analysis ${index}: ${'older reasoning '.repeat(500)}`))
		}
		messages.push(createUserMessage('Recover the exact DELTA receipt from recorded history.'))
		const events: RunEvent[] = []
		const result = await drainQuery(
			{
				provider,
				tools,
				runId,
				workingDirectory: directory,
				systemPrompt: 'Follow the authorized resident objective.',
				promptContributions: contributions,
				messages,
				compactionConfig: CompactionConfigSchema.parse({
					strategy,
					contextWindowTokens: 16_000,
					keepRecentMessages: 2,
					clearToolResults: false,
					llmVerification: false,
				}),
				runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 5 },
				agentId: 'recall-compaction',
				agentName: 'Recall compaction test',
				tenantId,
				sessionId: fixtureId.session('recall-compaction'),
				topicId: fixtureId.topic('recall-compaction'),
				projectId: fixtureId.project('recall-compaction'),
			},
			(event) => {
				events.push(event)
			},
		)
		expect(result.stopReason).toBe('end_turn')
		expect(provider.requests).toHaveLength(3)
		const compactedAt = events.findIndex((event) => event.type === 'compaction_completed')
		expect(compactedAt).toBeGreaterThanOrEqual(0)
		expect(events.findIndex((event) => event.type === 'tool_executing')).toBeGreaterThan(
			compactedAt,
		)
		expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain('CODE-ALPHA-471')
		for (const request of provider.requests) {
			const system = request.messages
				.filter((message) => message.role === 'system')
				.map((message) => message.content)
				.join('\n')
			expect(system).toContain('search_resident_history')
			expect(system).toContain(`"throughRevision":${snapshot.revision}`)
			expect(request.tools?.map((tool) => tool.function.name)).toContain('read_resident_history')
		}
		const exactReads = events.filter(
			(event) => event.type === 'tool_completed' && event.toolName === 'read_resident_history',
		)
		expect(exactReads).toHaveLength(1)
		expect(exactReads[0]).toMatchObject({
			isError: false,
			result: expect.stringContaining('CODE-ALPHA-471'),
		})
		expect(
			JSON.stringify(provider.requests[2]?.messages.filter((message) => message.role === 'tool')),
		).toContain('CODE-ALPHA-471')
	},
)
