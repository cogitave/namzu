import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { SessionPaths } from '../../../session/paths.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { ProjectId, SessionId, TenantId, TopicId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import { generateSessionId } from '../../../utils/id.js'
import { privateTempRootPath } from '../../../utils/temp.js'
import { type QueryParams, drainQuery } from '../index.js'
import {
	PLAN_MODE_REFUSAL,
	STRICT_MODE_REFUSAL,
	type ToolReviewPrompt,
	createReviewHandler,
} from '../review-policy.js'

/**
 * The session's own scratch folder is a working root: a file written there is
 * not asked about in `prompt`, `accept-edits` or `plan`, and is never "outside
 * the roots". A sibling session's folder, and any other path in the shared
 * temporary folder, stay outside.
 */

registerMock()

const dirs: string[] = []
let base: string

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), 'namzu-scratchpad-'))
	dirs.push(base)
	vi.stubEnv('NAMZU_TMPDIR', base)
})
afterEach(async () => {
	vi.unstubAllEnvs()
	await removeTempDirs(dirs)
	dirs.length = 0
})

const ids = {
	topicId: '78bd1b88-07a8-43ba-b3c1-cc02468a3781' as TopicId,
	projectId: '38018058-7f48-4a66-8cac-67bc513451f4' as ProjectId,
	tenantId: '56b14123-e653-4cef-ac96-21f2d79d9bbd' as TenantId,
}

async function run(input: {
	readonly mode: 'prompt' | 'accept-edits' | 'plan' | 'strict'
	readonly access?: 'refuse' | 'review'
	/** Where the model writes, given this session's scratchpad and a sibling's. */
	readonly target: (where: { own: string; sibling: string; base: string }) => string
	readonly beforeRun?: (where: { own: string; sibling: string }) => Promise<void>
}) {
	const home = await mkdtemp(join(tmpdir(), 'namzu-home-'))
	dirs.push(home)
	const cwd = join(home, 'project')
	await mkdir(cwd)
	const root = privateTempRootPath()
	const paths = new SessionPaths({ home, slug: '-project', tempRoot: root })
	const sessionId = generateSessionId()
	const own = paths.scratchpadPath(sessionId)
	const sibling = paths.scratchpadPath(generateSessionId() as SessionId)
	await input.beforeRun?.({ own, sibling })
	const target = join(input.target({ own, sibling, base }), 'note.txt')
	const tools = testToolset(WriteFileTool)
	const registry = new ToolManager({ toolsets: [tools], messages: () => [] })
	const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject', feedback: 'no' }))
	const call: MockTurn = {
		toolCalls: [{ id: 'w1', name: 'write', args: { path: target, content: 'SCRATCH_CONTENT' } }],
		finishReason: 'tool_calls',
	}
	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [call, { text: 'done' }] }),
		toolsets: [tools],
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('write it')],
		workingDirectory: cwd,
		outsideRootAccess: input.access ?? 'review',
		resumeHandler: createReviewHandler({ mode: input.mode, prompt, registry }),
		permissionMode: input.mode === 'plan' ? 'plan' : undefined,
		sessionId,
		sessionLog: new InMemorySessionLog({ sessionId }),
		paths,
		...ids,
	} as QueryParams)
	const texts = result.messages
		.filter((m) => m.role === 'tool' && typeof m.content === 'string')
		.map((m) => m.content as string)
		.join('\n')
	return {
		prompt,
		texts,
		target,
		written: await readFile(target, 'utf8').catch(() => undefined),
		own,
	}
}

describe('the session scratchpad', () => {
	it.each(['prompt', 'accept-edits', 'plan'] as const)(
		'takes a write in %s without asking, and makes the folder only then',
		async (mode) => {
			const out = await run({ mode, target: ({ own }) => own })
			expect(out.prompt).not.toHaveBeenCalled()
			expect(out.texts).not.toContain(PLAN_MODE_REFUSAL)
			expect(out.written).toBe('SCRATCH_CONTENT')
		},
	)

	it('leaves a sibling session scratchpad outside the roots', async () => {
		const out = await run({ mode: 'prompt', target: ({ sibling }) => sibling })
		expect(out.prompt).toHaveBeenCalledTimes(1)
		expect(out.prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation?.outsidePaths).toBeDefined()
		expect(out.written).toBeUndefined()
	})

	it('leaves any other path in the shared temporary folder outside the roots', async () => {
		const out = await run({ mode: 'prompt', target: ({ base: b }) => b })
		expect(out.prompt).toHaveBeenCalledTimes(1)
		expect(out.written).toBeUndefined()
	})

	it('still refuses a write outside the roots in plan, and a sibling scratchpad with it', async () => {
		const out = await run({ mode: 'plan', target: ({ sibling }) => sibling })
		expect(out.prompt).not.toHaveBeenCalled()
		expect(out.texts).toContain(PLAN_MODE_REFUSAL)
		expect(out.written).toBeUndefined()
	})

	it('is not free in strict, which asks about everything', async () => {
		const out = await run({ mode: 'strict', target: ({ own }) => own })
		expect(out.texts).toContain(STRICT_MODE_REFUSAL)
		expect(out.written).toBeUndefined()
	})

	it('is allowed where outside paths are refused outright, and a sibling folder is still refused', async () => {
		const own = await run({ mode: 'prompt', access: 'refuse', target: ({ own }) => own })
		expect(own.written).toBe('SCRATCH_CONTENT')
		const sibling = await run({
			mode: 'prompt',
			access: 'refuse',
			target: ({ sibling }) => sibling,
		})
		expect(sibling.written).toBeUndefined()
		// Asked about like any write (and declined here), never taken as a root.
		expect(sibling.prompt).toHaveBeenCalledTimes(1)
	})

	it('is not a root when a link stands where the folder should be', async () => {
		const out = await run({
			mode: 'prompt',
			target: ({ own }) => own,
			beforeRun: async ({ own }) => {
				const elsewhere = join(base, 'elsewhere')
				await mkdir(elsewhere)
				// The session folder's parent is a link to somewhere else.
				const parent = join(own, '..')
				await mkdir(join(parent, '..'), { recursive: true, mode: 0o700 })
				await symlink(elsewhere, parent)
			},
		})
		expect(out.prompt).toHaveBeenCalledTimes(1)
	})
})
