import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ToolRegistry } from '@namzu/sdk'
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
		{ tokenBudget: 1_000, expectedChildBudget: 500 },
		{ tokenBudget: undefined, expectedChildBudget: 500_000 },
		{ tokenBudget: 0, expectedChildBudget: 200_000 },
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
				expect((await runtime.gatewayForRun(parent.scope.runId)).listTasks()).toHaveLength(0)
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
