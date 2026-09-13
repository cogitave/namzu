import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createEvidenceRecallStep } from '../../../run/evidence-recall.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs.splice(0))
})

it.each(['query_planning', 'retrieval'] as const)(
	'exposes failed %s as unavailable context without passing private errors or replacing the operator',
	async (stage) => {
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-recall-availability-'))
		dirs.push(cwd)
		const scope = {
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
		}
		const privateDetail = 'PRIVATE_CREDENTIAL_OR_UNVERIFIED_OUTPUT'
		let retrievals = 0
		const provider = new MockLLMProvider({
			nextTurn: (request) => ({
				text: String(request.messages[0]?.content).startsWith(
					'Resolve a conversation-history search query.',
				)
					? privateDetail
					: 'No verified historical answer yet.',
			}),
		})
		const operator = createUserMessage('What was its earlier DELTA identifier?')
		const result = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			workingDirectory: cwd,
			...scope,
			topicId: generateTopicId(),
			agentId: 'availability',
			agentName: 'Availability',
			messages: [
				createUserMessage('Inspect the DELTA record.'),
				createAssistantMessage('It has an identifier.'),
				operator,
			],
			runConfig: { model: 'mock', maxIterations: 2, tokenBudget: 100_000, timeoutMs: 10_000 },
			prepareStep: [
				() => ({ context: 'Earlier stage context.', system: 'Stable policy.' }),
				createEvidenceRecallStep({
					scope,
					resolveQuery: stage === 'query_planning',
					retrieve: async () => {
						retrievals++
						if (stage === 'query_planning')
							return {
								candidates: [
									{
										scope: { ...scope, runId: generateRunId() },
										seq: 2,
										part: 0,
										source: 'tool_completed',
										retained: 'full',
										excerpt: 'DELTA earlier identifier: VERIFIED-789',
									},
								],
								scannedBytes: 100,
								incomplete: false,
							}
						throw new Error(privateDetail)
					},
				}),
			],
		})
		const request = provider.requests.at(-1)!
		const context = request.messages
			.filter(
				(m) =>
					m.role === 'user' &&
					m.source?.type === 'runtime-context' &&
					m.source.kind === 'step-context',
			)
			.map((m) => m.content)
			.join('\n')
		expect(context).toContain('Earlier stage context.')
		expect(context).toContain('"status":"unavailable"')
		expect(context).toContain(`"stage":"${stage}"`)
		if (stage === 'query_planning') {
			expect(context).toContain('"fallback":"literal_query"')
			expect(context).toContain('VERIFIED-789')
		} else expect(context).toContain('does not establish that earlier records are absent')
		expect(JSON.stringify(request)).not.toContain(privateDetail)
		expect(request.messages).toContainEqual(expect.objectContaining({ content: operator.content }))
		expect(
			request.messages
				.filter((m) => m.role === 'system')
				.map((m) => m.content)
				.join('\n'),
		).not.toContain('"status":"unavailable"')
		expect(JSON.stringify(result.messages)).not.toContain('"status":"unavailable"')
		expect(retrievals).toBe(1)
	},
)
