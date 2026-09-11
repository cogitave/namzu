import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatCompletionParams, type LLMProvider, ToolRegistry } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createWebSearchTool } from '../../web/search.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

it('carries the child-selected hosted search through ReactiveAgent into the provider request', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-native-search-'))
	const parent = await subagentParentFixture(cwd)
	const requests: ChatCompletionParams[] = []
	const events: unknown[] = []
	const provider: LLMProvider = {
		id: 'native',
		name: 'Native',
		capabilities: {
			supportsTools: true,
			supportsStreaming: true,
			supportsFunctionCalling: true,
			supportsHostedWebSearch: true,
		},
		async *chatStream(p) {
			requests.push(p)
			yield {
				id: 'answer',
				delta: { content: 'https://example.com' },
				finishReason: 'stop',
				usage: {
					promptTokens: 1,
					completionTokens: 1,
					totalTokens: 2,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
			}
		},
	}
	const runtime = await createSubagentRuntime({
		onEvent: (event) => events.push(event),
		cwd,
		model: 'child-model',
		resolveParent: parent.resolveParent,
		buildProvider: () => provider,
		buildTools: () => {
			const r = new ToolRegistry()
			r.register(createWebSearchTool())
			return r
		},
		configureWebSearch: (selected, model, tools) => {
			events.push({
				phase: 'configure',
				same: selected === provider,
				model,
				names: tools.listNames(),
			})
			tools.unregister('web_search')
			return { mode: 'live' }
		},
	})
	try {
		const result = await runtime.agentTool.execute(
			{ description: 'Search', prompt: 'Find one official source', subagent_type: 'explore' },
			{
				runId: parent.scope.runId,
				workingDirectory: cwd,
				abortSignal: new AbortController().signal,
				env: {},
				log() {},
			},
		)
		expect(result.success, JSON.stringify(events)).toBe(true)
		expect(requests).toHaveLength(1)
		expect(requests[0]?.webSearch).toEqual({ mode: 'live' })
		expect(requests[0]?.tools?.some((t) => t.function.name === 'web_search') ?? false).toBe(false)
		expect(
			requests[0]?.messages.some(
				(m) => m.role === 'system' && m.content.includes('Provider-hosted web_search'),
			),
		).toBe(true)
	} finally {
		await runtime.close()
		removeTempDir(cwd)
	}
})
