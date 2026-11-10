import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { GlobTool } from '../../../tools/builtins/glob.js'
import { GrepTool } from '../../../tools/builtins/grep.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { ToolManager } from '../../../toolsets/manager.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TenantId, TopicId } from '../../../types/session/ids.js'
import { generateSessionId } from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import { createReviewHandler } from '../review-policy.js'

/**
 * `outsideRootAccess: 'refuse'` with `outsideRootRefusal`: a file tool's path
 * outside the roots is answered with the host's own sentence before any
 * review, so no permission mode (bypass included) lifts it. Without the
 * sentence the tool's own refusal stands, and `'review'` still asks.
 */

registerMock()

const NOTE = 'WALL: the setting permissions.outsideRoot is refuse.'
const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const ids = {
	topicId: '78bd1b88-07a8-43ba-b3c1-cc02468a3781' as TopicId,
	projectId: '38018058-7f48-4a66-8cac-67bc513451f4' as ProjectId,
	tenantId: '56b14123-e653-4cef-ac96-21f2d79d9bbd' as TenantId,
}

const texts = (messages: readonly Message[]): string =>
	messages
		.filter((m) => m.role === 'tool' && typeof m.content === 'string')
		.map((m) => m.content as string)
		.join('\n')

async function run(input: {
	readonly tool: string
	readonly args: (paths: { inside: string; outside: string; extra: string }) => Record<
		string,
		unknown
	>
	readonly outsideRootAccess?: 'refuse' | 'review'
	readonly note?: string
	readonly mode?: 'bypass' | 'auto' | 'prompt'
}) {
	const base = await mkdtemp(join(tmpdir(), 'namzu-outside-root-'))
	dirs.push(base)
	const cwd = join(base, 'project')
	const outsideDir = join(base, 'outside')
	const extraDir = join(base, 'extra')
	for (const d of [cwd, outsideDir, extraDir]) await mkdir(d)
	const inside = join(cwd, 'in.txt')
	const outside = join(outsideDir, 'out.txt')
	const extra = join(extraDir, 'extra.txt')
	for (const f of [inside, outside, extra]) await writeFile(f, 'SECRET_ONE\n')
	const toolsets = testToolset(ReadFileTool, WriteFileTool, EditTool, GlobTool, GrepTool)
	const registry = new ToolManager({ toolsets: [toolsets], messages: () => [] })
	const sessionId = generateSessionId()
	const sessionLog = new InMemorySessionLog({ sessionId })
	const result = await drainQuery({
		provider: new MockLLMProvider({
			turns: [
				{
					toolCalls: [{ id: 'c1', name: input.tool, args: input.args({ inside, outside, extra }) }],
					finishReason: 'tool_calls',
				},
				{ text: 'done' },
			],
		}),
		toolsets: [toolsets],
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory: cwd,
		additionalDirectories: [extraDir],
		...(input.outsideRootAccess ? { outsideRootAccess: input.outsideRootAccess } : {}),
		...(input.note ? { outsideRootRefusal: input.note } : {}),
		resumeHandler: createReviewHandler({ mode: input.mode ?? 'bypass', registry }),
		sessionId,
		sessionLog,
		...ids,
	} as QueryParams)
	return { out: texts(result.messages), inside, outside, extra }
}

const READ = (p: { inside: string; outside: string; extra: string }) => ({ path: p.outside })

describe('outsideRootAccess: refuse with a host sentence', () => {
	it.each(['bypass', 'auto', 'prompt'] as const)(
		'refuses a read outside the roots in %s mode and names the setting',
		async (mode) => {
			const { out, outside } = await run({
				tool: 'read',
				args: READ,
				outsideRootAccess: 'refuse',
				note: NOTE,
				mode,
			})
			expect(out).toContain(NOTE)
			expect(out).toContain(outside)
			expect(out).not.toContain('SECRET_ONE')
		},
	)

	it('refuses a write outside and leaves the file as it was', async () => {
		const { out, outside } = await run({
			tool: 'write',
			args: (p) => ({ path: p.outside, content: 'CHANGED' }),
			outsideRootAccess: 'refuse',
			note: NOTE,
		})
		expect(out).toContain(NOTE)
		expect(await readFile(outside, 'utf8')).toBe('SECRET_ONE\n')
	})

	it('refuses an edit outside and leaves the file as it was', async () => {
		const { out, outside } = await run({
			tool: 'edit',
			args: (p) => ({ path: p.outside, old_string: 'SECRET_ONE', new_string: 'CHANGED' }),
			outsideRootAccess: 'refuse',
			note: NOTE,
		})
		expect(out).toContain(NOTE)
		expect(await readFile(outside, 'utf8')).toBe('SECRET_ONE\n')
	})

	it('refuses a glob and a grep rooted outside', async () => {
		for (const [tool, args] of [
			['glob', (p: { outside: string }) => ({ pattern: '*', path: join(p.outside, '..') })],
			['grep', (p: { outside: string }) => ({ pattern: 'SECRET', path: join(p.outside, '..') })],
		] as const) {
			const { out } = await run({ tool, args, outsideRootAccess: 'refuse', note: NOTE })
			expect(out, tool).toContain(NOTE)
		}
	})

	it('allows a read inside the working directory and inside an added directory', async () => {
		const inside = await run({
			tool: 'read',
			args: (p) => ({ path: p.inside }),
			outsideRootAccess: 'refuse',
			note: NOTE,
		})
		expect(inside.out).toContain('SECRET_ONE')
		expect(inside.out).not.toContain(NOTE)
		const extra = await run({
			tool: 'read',
			args: (p) => ({ path: p.extra }),
			outsideRootAccess: 'refuse',
			note: NOTE,
		})
		expect(extra.out).toContain('SECRET_ONE')
	})

	it('allows a write inside the working directory', async () => {
		const { out, inside } = await run({
			tool: 'write',
			args: (p) => ({ path: join(p.inside, '..', 'new.txt'), content: 'NEW' }),
			outsideRootAccess: 'refuse',
			note: NOTE,
		})
		expect(out).not.toContain(NOTE)
		expect(await readFile(join(inside, '..', 'new.txt'), 'utf8')).toBe('NEW')
	})
})

describe('without the sentence, or on a reviewing host', () => {
	it("keeps the tool's own refusal when no sentence is given", async () => {
		const { out } = await run({ tool: 'read', args: READ, outsideRootAccess: 'refuse' })
		expect(out).toMatch(/escapes the working directory/)
		expect(out).not.toContain(NOTE)
		expect(out).not.toContain('SECRET_ONE')
	})

	it('does not use the sentence on a reviewing host: bypass reads it as before', async () => {
		const { out } = await run({
			tool: 'read',
			args: READ,
			outsideRootAccess: 'review',
			note: NOTE,
			mode: 'bypass',
		})
		expect(out).not.toContain(NOTE)
	})
})
