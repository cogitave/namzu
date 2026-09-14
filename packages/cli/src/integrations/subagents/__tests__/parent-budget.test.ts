import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ToolRegistry, mcpJsonSchemaToZod } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { SubagentPathBuilder } from '../parent.js'
import { createSubagentRuntime } from '../runtime.js'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDir(directory)
})

describe('CLI delegation uses the parent token limit', () => {
	it.each([
		{ maxIterations: 0, requests: 43, success: true },
		{ maxIterations: 2, requests: 2, success: false },
	])('parallel children honor explicit limits and retain receipts: %j', async (test) => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-unlimited-children-'))
		directories.push(cwd)
		const parent = await subagentParentFixture(cwd)
		const stateRoot = join(cwd, 'state')
		const providers: MockLLMProvider[] = []
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'mock',
			tokenBudget: 0,
			maxIterations: test.maxIterations,
			timeoutMs: 0,
			resolveResumeHandler: () => async (request) =>
				request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
			resolveParent: parent.resolveParent,
			pathBuilder: new SubagentPathBuilder(stateRoot, parent.scope.projectId),
			buildProvider: () => {
				const provider = new MockLLMProvider({
					nextTurn: (_request, index) => ({
						...(index < 42
							? { toolCalls: [{ name: 'observe', args: { index } }] }
							: { text: 'done' }),
						usage: { promptTokens: 10_000, completionTokens: 1 },
					}),
				})
				providers.push(provider)
				return provider
			},
			buildTools: () => {
				const tools = new ToolRegistry()
				tools.register({
					name: 'observe',
					description: 'Observe a sample',
					inputSchema: mcpJsonSchemaToZod({
						type: 'object',
						properties: { index: { type: 'number' } },
						required: ['index'],
					}),
					execute: async () => ({ success: true, output: 'observed' }),
				})
				return tools
			},
		})
		try {
			const results = await Promise.all(
				[0, 1].map((index) =>
					runtime.agentTool.execute(
						{
							description: `inspect ${index}`,
							prompt: `observe sequence ${index}`,
						},
						{
							runId: parent.scope.runId,
							workingDirectory: cwd,
							abortSignal: new AbortController().signal,
							env: {},
							log() {},
						},
					),
				),
			)
			expect(
				results.map((result) => result.success),
				JSON.stringify(results),
			).toEqual([test.success, test.success])
			expect(
				providers.map((provider) => provider.requests.length),
				JSON.stringify(results),
			).toEqual([test.requests, test.requests])
			const runs = readdirSync(stateRoot, {
				recursive: true,
				encoding: 'utf8',
			}).filter((file) => file.endsWith('/run.json'))
			expect(runs).toHaveLength(2)
			for (const path of runs) {
				const run = JSON.parse(readFileSync(join(stateRoot, path), 'utf8'))
				expect(run.metadata.config).toMatchObject({
					tokenBudget: 0,
					maxIterations: test.maxIterations,
					timeoutMs: 0,
				})
				expect(run.budget).toMatchObject({
					limit: 0,
					ownTokens: test.requests * 10_001,
					treeTokens: test.requests * 10_001,
					remainingTokens: null,
					unresolvedRequests: 0,
				})
			}
		} finally {
			await runtime.close()
		}
	})
	it.each([
		{ tokenBudget: 1_000, expectedChildBudget: 111 },
		{ tokenBudget: undefined, expectedChildBudget: 0 },
		{ tokenBudget: 0, expectedChildBudget: 0 },
		{ tokenBudget: 1, expectedChildBudget: undefined },
	])('reserves from $tokenBudget without inventing extra budget', async (testCase) => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-parent-budget-'))
		directories.push(cwd)
		const parent = await subagentParentFixture(cwd)
		const stateRoot = join(cwd, 'state')
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'mock',
			tokenBudget: testCase.tokenBudget,
			resolveParent: parent.resolveParent,
			pathBuilder: new SubagentPathBuilder(stateRoot, parent.scope.projectId),
			buildProvider: () => provider,
			buildTools: () => new ToolRegistry(),
		})
		try {
			const result = await runtime.agentTool.execute(
				{ description: 'inspect', prompt: 'report' },
				{
					runId: parent.scope.runId,
					workingDirectory: cwd,
					abortSignal: new AbortController().signal,
					env: {},
					log() {},
				},
			)
			if (testCase.expectedChildBudget === undefined) {
				expect(result.success).toBe(false)
				expect(provider.requests).toHaveLength(0)
				expect((await runtime.gatewayForRun(parent.scope.runId)).listTasks()).toMatchObject([
					{ state: 'failed' },
				])
				return
			}
			expect(result.success).toBe(true)
			expect(provider.requests).toHaveLength(1)
			const runs = readdirSync(stateRoot, {
				recursive: true,
				encoding: 'utf8',
			}).filter((file) => file.endsWith('/run.json'))
			expect(runs).toHaveLength(1)
			const run = JSON.parse(readFileSync(join(stateRoot, runs[0]!), 'utf8'))
			expect(run.metadata.config.tokenBudget).toBe(testCase.expectedChildBudget)
		} finally {
			await runtime.close()
		}
	})
})
