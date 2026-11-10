import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	MockLLMProvider,
	SessionPaths,
	type Toolset,
	mcpJsonSchemaToZod,
	toolset,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

/**
 * A delegated child refuses a path outside its roots with the parent's own
 * sentence, not the tool's generic one. `outsideRootRefusal` was set on the
 * child's config but `QueryAgent` had no route for it, so only the parent's
 * turn ever carried the words.
 */

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

const SENTENCE = 'Your settings (permissions.outsideRoot: refuse) do not allow this. Use --add-dir.'

it('hands a child the sentence the parent refuses with', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-outside-'))
	dirs.push(cwd)
	const parent = await subagentParentFixture(cwd)
	let ran = false
	const child = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'peek', args: { path: '/etc/hosts' } }] },
			{ text: 'ok' },
		],
	})
	const buildTools = (): readonly Toolset[] => [
		toolset('test', [
			{
				name: 'peek',
				description: 'peek',
				pathArgument: 'path',
				inputSchema: mcpJsonSchemaToZod({
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path'],
				}),
				execute: async () => {
					ran = true
					return { success: true, output: 'peeked' }
				},
			},
		]),
	]
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'parent-model',
		resolveParent: parent.resolveParent,
		buildTools,
		buildProvider: () => child,
		resolveResumeHandler: () => async (request) =>
			request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
		paths: new SessionPaths({ home: join(cwd, 'state'), slug: '-work-child-outside' }),
		outsideRootAccess: 'refuse',
		outsideRootRefusal: SENTENCE,
	})
	try {
		const result = await runtime.agentTool.execute(
			{ description: 'peek', prompt: 'peek outside' },
			{
				sessionId: parent.scope.sessionId,
				turnId: parent.scope.turnId,
				workingDirectory: cwd,
				abortSignal: new AbortController().signal,
				env: {},
				log() {},
			},
		)
		if (!result.success) throw new Error(JSON.stringify(result))
	} finally {
		await runtime.close()
	}

	expect(ran).toBe(false)
	expect(JSON.stringify(child.requests)).toContain(SENTENCE)
})
