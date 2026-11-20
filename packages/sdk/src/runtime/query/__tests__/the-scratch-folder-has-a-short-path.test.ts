import { lstat, mkdir, mkdtemp, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { SessionPaths } from '../../../session/paths.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { ProjectId, TenantId, TopicId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { generateSessionId } from '../../../utils/id.js'
import { privateTempRootPath, scratchpadAlias } from '../../../utils/temp.js'
import { type QueryParams, drainQuery } from '../index.js'
import { createReviewHandler } from '../review-policy.js'

/**
 * The scratch folder keeps its long encoded path, and a shell command also gets
 * a short one: `$NAMZU_SCRATCH`, a link to the same folder. A command that typed
 * the long path wrong read as "the write did not happen".
 */

registerMock()

const dirs: string[] = []
beforeEach(async () => {
	const base = await mkdtemp(join(tmpdir(), 'namzu-scratch-alias-'))
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

describe('scratchpadAlias', () => {
	it('is a short link to the real folder, the same one every time', async () => {
		const root = privateTempRootPath()
		const real = join(root, '-home-someone-a-long-project-name', 'session-id', 'scratchpad')
		await mkdir(real, { recursive: true, mode: 0o700 })
		const alias = scratchpadAlias(real)
		expect(alias.startsWith(join(root, 's-'))).toBe(true)
		expect(alias.length).toBeLessThan(real.length)
		expect(await readlink(alias)).toBe(real)
		expect(scratchpadAlias(real)).toBe(alias)
	})

	it('falls back to the real folder when the name is taken by something that is not a link', async () => {
		const root = privateTempRootPath()
		const real = join(root, 'p', 's', 'scratchpad')
		await mkdir(real, { recursive: true, mode: 0o700 })
		const alias = scratchpadAlias(real)
		const { rm } = await import('node:fs/promises')
		await rm(alias)
		await writeFile(alias, 'not a link')
		expect(scratchpadAlias(real)).toBe(real)
		expect((await lstat(alias)).isFile()).toBe(true)
	})

	it('re-points a link of ours that leads somewhere else', async () => {
		const root = privateTempRootPath()
		const real = join(root, 'p', 's', 'scratchpad')
		await mkdir(real, { recursive: true, mode: 0o700 })
		const alias = scratchpadAlias(real)
		const { rm, symlink } = await import('node:fs/promises')
		await rm(alias)
		await symlink(join(root, 'elsewhere'), alias)
		expect(scratchpadAlias(real)).toBe(alias)
		expect(await readlink(alias)).toBe(real)
	})
})

describe('NAMZU_SCRATCH in a shell command', () => {
	it('names the same folder as the long path, through the short link', async () => {
		const home = await mkdtemp(join(tmpdir(), 'namzu-home-'))
		dirs.push(home)
		const cwd = join(home, 'project')
		await mkdir(cwd)
		const paths = new SessionPaths({
			home,
			slug: '-project',
			tempRoot: privateTempRootPath(),
		})
		const sessionId = generateSessionId()
		const own = paths.scratchpadPath(sessionId)
		const tools = testToolset(BashTool)
		const registry = new ToolManager({ toolsets: [tools], messages: () => [] })
		const result = await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								id: 'b1',
								name: 'bash',
								args: {
									command: 'echo "$NAMZU_SCRATCH" && echo hello > "$NAMZU_SCRATCH/note.txt"',
								},
							},
						],
						finishReason: 'tool_calls',
					},
					{ text: 'done' },
				],
			}),
			toolsets: [tools],
			turnConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 200_000,
				maxIterations: 4,
			},
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('write it')],
			workingDirectory: cwd,
			resumeHandler: createReviewHandler({ mode: 'bypass', registry }),
			sessionId,
			sessionLog: new InMemorySessionLog({ sessionId }),
			paths,
			...ids,
		} as QueryParams)
		const output = result.messages
			.filter((m) => m.role === 'tool' && typeof m.content === 'string')
			.map((m) => m.content as string)
			.join('\n')
		const alias = scratchpadAlias(own)
		expect(output).toContain(alias)
		expect(alias).not.toBe(own)
		expect(await readlink(alias)).toBe(own)
		const { readFile } = await import('node:fs/promises')
		expect(await readFile(join(own, 'note.txt'), 'utf8')).toBe('hello\n')
	})
})
