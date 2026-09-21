import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { DiskResidentAgenda } from '../../../manager/resident/agenda.js'
import { createResidentToolEvidenceSource } from '../../../manager/resident/tool-evidence.js'
import { PromptContributionRegistry } from '../../../prompt/contributions.js'
import { createResidentStepContributions } from '../../../prompt/resident-step.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createSessionEvidenceSource } from '../../../store/evidence/disk.js'
import { fixtureId } from '../../../test-support/ids.js'
import { buildResidentToolEvidenceTools } from '../../../tools/resident-tool-evidence.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { drainQuery } from '../index.js'
import { resolveSessionStorage } from '../session-storage.js'
import { records } from './support/session.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

it.each(['structured', 'sliding-window'] as const)(
	'recovers a real effect receipt after %s compaction without executing the effect again',
	async (strategy) => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-tool-recall-query-'))
		roots.push(root)
		const scope = {
			tenantId: fixtureId.tenant(strategy),
			projectId: fixtureId.project(strategy),
			sessionId: fixtureId.session(`seed-${strategy}`),
			turnId: fixtureId.turn(`seed-${strategy}`),
		}
		const topicId = fixtureId.topic(strategy)
		const agenda = new DiskResidentAgenda(join(root, 'agenda'), {
			tenantId: scope.tenantId,
			agentKey: 'receipt',
		})
		const pursuit = await agenda.add(
			await agenda.create('Preserve effect evidence.'),
			'Recover the exact receipt; never mint twice.',
		)
		const execution = agenda.execution(pursuit.id)
		const claim = await execution.claim(pursuit.state, 1)
		const tools = new ToolRegistry()
		let effects = 0
		const exact = 'RECEIPT-CODE ALPHA-739 🦉'
		const output = `${'earlier record '.repeat(8000)}\n${exact}\n${'later record '.repeat(8000)}`
		tools.register({
			name: 'mint_receipt',
			description: 'Create a one-time receipt.',
			inputSchema: z.object({}).strict(),
			execute: async () => {
				effects++
				await writeFile(join(root, 'effect-count'), String(effects))
				return { success: true, output }
			},
		})
		const common = {
			workingDirectory: root,
			agentId: 'receipt',
			agentName: 'Receipt test',
			topicId,
			systemPrompt: 'Follow the authorized objective.',
			turnConfig: { model: 'mock', maxIterations: 6, timeoutMs: 20_000, tokenBudget: 200_000 },
		}
		const first = await drainQuery({
			...common,
			...scope,
			tools,
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'mint-once', name: 'mint_receipt', args: {} }] },
					{ text: 'Receipt retained; await confirmation.' },
				],
			}),
			messages: [createUserMessage('Mint one receipt.')],
		})
		expect(first.stopReason).toBe('end_turn')
		const settled = await execution.settle(
			claim,
			{ kind: 'wait', summary: 'Receipt retained; await confirmation.', wakeAt: null },
			3,
		)
		const revision = (await agenda.read())!.revision
		// The session's log on disk, under NAMZU_HOME for the working directory.
		const storage = await resolveSessionStorage({
			sessionId: scope.sessionId,
			workingDirectory: root,
		})
		const logPath = (storage.log as { file?: string }).file as string
		const completed = (await records(storage.log)).find(
			(record) => record.type === 'tool_completed',
		) as unknown as { isError: boolean; result: string; outputSpillIntegrity?: string }
		expect(completed.isError, completed.result).toBe(false)
		expect(effects).toBe(1)
		expect(completed.outputSpillIntegrity).toMatch(/^[a-f0-9]{64}$/)
		expect(completed.result).not.toContain(exact)
		const source = createResidentToolEvidenceSource({
			history: new DiskResidentAgenda(join(root, 'agenda'), {
				tenantId: scope.tenantId,
				agentKey: 'receipt',
			}).history(settled, revision),
			projectId: scope.projectId,
			resolveTurn: async (entry) => {
				expect(entry.claimId).toBe(claim.claimId)
				return createSessionEvidenceSource({ scope, logPath })
			},
		})
		// Obtain the deterministic test script's address through the public search API.
		let search = await source.search({ query: 'RECEIPT-CODE' })
		while (!search.evidence?.matches.length && search.nextCursor)
			search = await source.search({ query: 'RECEIPT-CODE', cursor: search.nextCursor })
		const match = search.evidence!.matches[0]!
		const reader = new ToolRegistry()
		reader.register(buildResidentToolEvidenceTools(() => source))
		const contributions = new PromptContributionRegistry()
		for (const contribution of createResidentStepContributions({
			state: settled,
			history: source.scope,
			toolEvidence: true,
			outputInstructions: 'Report exact retained evidence.',
		}))
			contributions.register(contribution)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ id: 'search-old', name: 'search_resident_tools', args: { query: 'RECEIPT-CODE' } },
					],
				},
				{
					toolCalls: [
						{
							id: 'read-old',
							name: 'read_resident_tool',
							args: {
								revision: search.revision,
								address: match.address,
								byteOffset: match.byteOffset,
							},
						},
					],
				},
				{ text: 'Recovered the retained receipt.' },
			],
		})
		const messages: Message[] = [createUserMessage(`${'old context '.repeat(800)} ${exact}`)]
		for (let i = 0; i < 18; i++)
			messages.push(
				createUserMessage(`Old investigation ${i}: ${'irrelevant '.repeat(800)}`),
				createAssistantMessage('old reasoning '.repeat(700)),
			)
		messages.push(createUserMessage('Recover the original receipt. Do not mint another.'))
		const events: SessionEvent[] = []
		const result = await drainQuery(
			{
				...common,
				tenantId: scope.tenantId,
				projectId: scope.projectId,
				sessionId: fixtureId.session(`read-${strategy}`),
				turnId: fixtureId.turn(`read-${strategy}`),
				provider,
				tools: reader,
				messages,
				promptContributions: contributions,
				compactionConfig: CompactionConfigSchema.parse({
					strategy,
					contextWindowTokens: 16_000,
					keepRecentMessages: 2,
					clearToolResults: false,
					llmVerification: false,
				}),
			},
			(event) => {
				events.push(event)
			},
		)
		expect(result.stopReason).toBe('end_turn')
		expect(
			events.findIndex((event) => event.type === 'compaction_completed'),
		).toBeGreaterThanOrEqual(0)
		expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain(exact)
		expect(
			events.find(
				(event) => event.type === 'tool_completed' && event.toolName === 'read_resident_tool',
			),
		).toMatchObject({ isError: false, result: expect.stringContaining(exact) })
		for (const request of provider.requests)
			expect(
				JSON.stringify(request.messages.filter((message) => message.role === 'system')),
			).toContain('search_resident_tools')
		expect(effects).toBe(1)
		expect(await readFile(join(root, 'effect-count'), 'utf8')).toBe('1')
	},
)
