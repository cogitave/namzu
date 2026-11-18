import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { SessionPaths } from '../../../session/paths.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { JobTool } from '../../../tools/builtins/job.js'
import { WaitForJobTool } from '../../../tools/builtins/wait-for-job.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId } from '../../../types/ids/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { privateTempRootPath } from '../../../utils/temp.js'
import { BackgroundJobRegistry } from '../../jobs/registry.js'
import { drainQuery } from '../index.js'

/**
 * A scratch folder exists from the moment a session runs, whatever kind of
 * session it is, so the model is never left to invent a place for the files
 * that are not part of the work. Background jobs keep their output in it.
 */

// The scripted model names the first job's id before the call that makes it
// returns, so ids are handed out in order.
vi.mock('../../jobs/job-id.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../jobs/job-id.js')>()),
	createBackgroundJobId: (isTaken: (id: string) => boolean = () => false) => {
		for (let n = 1; ; n += 1) {
			const id = `b${String(n).padStart(8, '0')}`
			if (!isTaken(id)) return id
		}
	},
}))

const dirs: string[] = []
let base: string

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), 'namzu-session-scratch-'))
	dirs.push(base)
	vi.stubEnv('NAMZU_TMPDIR', base)
})
afterEach(async () => {
	vi.unstubAllEnvs()
	await removeTempDirs(dirs)
	dirs.length = 0
})

function startTool() {
	return defineTool({
		name: 'start',
		description: 'starts a short background job',
		inputSchema: z.object({ command: z.string() }),
		category: 'shell',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		execute: async ({ command }, context) => {
			const job = context.backgroundJobs?.start({
				command,
				workingDirectory: context.workingDirectory,
			})
			return { success: true, output: `started ${job?.id ?? 'nothing'} ${job?.outputFile ?? ''}` }
		},
	})
}

async function run(extra: Record<string, unknown>, turns = [{ text: 'done' }] as never[]) {
	const sessionId = generateSessionId()
	const provider = new MockLLMProvider({ turns })
	const result = await drainQuery({
		provider,
		toolsets: [testToolset(startTool(), JobTool, WaitForJobTool)],
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: base,
		projectId: generateProjectId(),
		sessionId,
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		turnConfig: { model: 'mock', maxIterations: 6, tokenBudget: 200_000, timeoutMs: 20_000 },
		...extra,
	} as never)
	return { result, sessionId }
}

describe('the session scratch folder', () => {
	it('is there after a turn that never used a tool, owner-only, when the session has a layout on disk', async () => {
		const paths = new SessionPaths({ home: join(base, 'home'), slug: '-project' })
		const sessionId = generateSessionId()
		const expected = paths.scratchpadPath(sessionId)
		expect(existsSync(expected)).toBe(false)
		await run({ paths, sessionId, sessionLog: new InMemorySessionLog({ sessionId }) })
		expect(statSync(expected).isDirectory()).toBe(true)
		if (process.platform !== 'win32') expect(statSync(expected).mode & 0o777).toBe(0o700)
	})

	it('is there for a session that keeps no state on disk, where the host names it', async () => {
		const sessionId = generateSessionId()
		const named = join(privateTempRootPath(), 'ephemeral', sessionId, 'scratchpad')
		expect(existsSync(named)).toBe(false)
		await run({
			sessionId,
			sessionLog: new InMemorySessionLog({ sessionId }),
			scratchpadDirectory: named,
		})
		expect(statSync(named).isDirectory()).toBe(true)
	})

	it('is not made where the host names a folder outside the private temporary folder', async () => {
		const sessionId = generateSessionId()
		const elsewhere = join(base, 'not-private', 'scratchpad')
		await run({
			sessionId,
			sessionLog: new InMemorySessionLog({ sessionId }),
			scratchpadDirectory: elsewhere,
		})
		expect(existsSync(elsewhere)).toBe(false)
	})

	it('is a delegated turn using its parent session folder, not one of its own', async () => {
		const paths = new SessionPaths({ home: join(base, 'home'), slug: '-project' })
		const parent = generateSessionId() as SessionId
		const child = generateSessionId() as SessionId
		await run({
			paths,
			sessionId: child,
			parentSessionId: parent,
			sessionLog: new InMemorySessionLog({ sessionId: child }),
		})
		expect(existsSync(paths.scratchpadPath(parent))).toBe(true)
		expect(existsSync(paths.scratchpadPath(child))).toBe(false)
	})

	it('holds a background job’s output, and the model is told the path in the wait result', async () => {
		const sessionId = generateSessionId()
		const named = join(privateTempRootPath(), 'ephemeral', sessionId, 'scratchpad')
		const { result } = await run(
			{
				sessionId,
				sessionLog: new InMemorySessionLog({ sessionId }),
				scratchpadDirectory: named,
				backgroundJobs: new BackgroundJobRegistry(),
			},
			[
				{ toolCalls: [{ id: 'c1', name: 'start', args: { command: 'printf build-output' } }] },
				{ toolCalls: [{ id: 'c2', name: 'wait_for_job', args: { id: 'b00000001' } }] },
				{ text: 'done' },
			] as never[],
		)
		const file = join(named, 'jobs', 'b00000001.log')
		const tools = result.messages
			.filter((m) => m.role === 'tool' && typeof m.content === 'string')
			.map((m) => m.content as string)
			.join('\n')
		expect(tools).toContain(`started b00000001 ${file}`)
		expect(tools).toContain(`the whole output is in ${file}`)
		expect(readFileSync(file, 'utf8')).toBe('build-output')
	})
})
