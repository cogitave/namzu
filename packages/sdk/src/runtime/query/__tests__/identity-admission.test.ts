import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import {
	MockLLMProvider,
	ToolRegistry,
	createUserMessage,
	drainQuery,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	query,
} from '../../../index.js'

describe.each(['query', 'drainQuery'] as const)('%s identity admission', (entryPoint) => {
	const workdirs: string[] = []
	afterEach(async () => {
		await removeTempDirs(workdirs.splice(0))
	})

	it.each(
		(['sessionId', 'topicId', 'projectId', 'tenantId'] as const).flatMap((field) =>
			[undefined, null, ''].map((value) => ({ field, value })),
		),
	)(
		'rejects $field=$value before inference or filesystem persistence',
		async ({ field, value }) => {
			const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-query-identity-'))
			workdirs.push(workingDirectory)
			const provider = new MockLLMProvider({ turns: [{ text: 'must not be called' }] })
			const params: Parameters<typeof query>[0] = {
				provider,
				tools: new ToolRegistry(),
				runConfig: { model: 'mock-model', tokenBudget: 2_000, timeoutMs: 2_000, maxIterations: 1 },
				agentId: 'identity-admission',
				agentName: 'Identity admission',
				messages: [createUserMessage('No inference without complete identity.')],
				workingDirectory,
				sessionId: generateSessionId(),
				topicId: generateTopicId(),
				projectId: generateProjectId(),
				tenantId: generateTenantId(),
				resumeHandler: async () => ({ action: 'abort', reason: 'Unexpected review request' }),
			}
			// Exercise untyped JavaScript/JSON callers through the public entry points.
			Object.assign(params, { [field]: value })
			let emittedEvents = 0
			const execute = async () => {
				if (entryPoint === 'drainQuery') {
					await drainQuery(params, () => {
						emittedEvents++
					})
				} else {
					for await (const _event of query(params)) emittedEvents++
				}
			}

			await expect(execute()).rejects.toMatchObject({
				code: 'invalid_config',
				details: { missingFields: [field] },
			})
			expect(provider.requests).toHaveLength(0)
			expect(emittedEvents).toBe(0)
			expect(await readdir(workingDirectory)).toEqual([])
		},
	)
})
