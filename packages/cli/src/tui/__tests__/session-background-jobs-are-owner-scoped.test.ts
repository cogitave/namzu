/** The operator's job panel may only read or stop this session's processes. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type BackgroundJob, BackgroundJobRegistry, UnknownBackgroundJobError } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { createAgentSession } from '../agent.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

const preferences = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

const detected = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'claude-sonnet-4-5',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: 'env',
		apiKey: 'sk-ant-not-a-real-key',
		alternatives: [],
	},
] as unknown as DetectedProvider[]

const temporaryDirectories: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	queryCalls.length = 0
	for (const directory of temporaryDirectories.splice(0)) removeTempDir(directory)
})

it('reads and stops own jobs while treating another owner’s id as unknown', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-job-panel-cwd-'))
	const stateRoot = mkdtempSync(join(tmpdir(), 'namzu-job-panel-state-'))
	temporaryDirectories.push(cwd, stateRoot)
	const session = await createAgentSession(preferences, detected, { cwd, stateRoot })
	try {
		for await (const _ of session.send([{ role: 'user', content: 'hello', timestamp: 0 }])) {
			// The fake query records the real registry and owner the turn received.
		}
		const registry = queryCalls[0]?.backgroundJobs
		expect(registry).toBeInstanceOf(BackgroundJobRegistry)
		const jobs = registry as BackgroundJobRegistry
		const owner = queryCalls[0]?.backgroundJobOwner as string
		const own: BackgroundJob = {
			id: 'job_own',
			owner,
			command: 'npm run dev',
			status: 'running',
			startedAt: 0,
		}
		const foreign: BackgroundJob = { ...own, id: 'job_foreign', owner: 'another-session' }
		vi.spyOn(jobs, 'get').mockImplementation((id) => {
			if (id === own.id) return own
			if (id === foreign.id) return foreign
			throw new UnknownBackgroundJobError({ id })
		})
		const output = {
			chunk: 'ready on 3000\n',
			nextOffset: 18,
			droppedBytes: 0,
			status: 'running' as const,
		}
		const read = vi.spyOn(jobs, 'read').mockReturnValue(output)
		const stopped = { ...own, status: 'killed' as const }
		const kill = vi.spyOn(jobs, 'kill').mockResolvedValue(stopped)

		expect(session.readJob?.(own.id, 5)).toEqual(output)
		expect(read).toHaveBeenCalledExactlyOnceWith(own.id, { fromOffset: 5 })
		expect(() => session.readJob?.(foreign.id)).toThrow(UnknownBackgroundJobError)
		expect(read).toHaveBeenCalledTimes(1)

		await expect(session.stopJob?.(own.id)).resolves.toEqual(stopped)
		expect(kill).toHaveBeenCalledExactlyOnceWith(own.id)
		await expect(session.stopJob?.(foreign.id)).rejects.toThrow(UnknownBackgroundJobError)
		expect(kill).toHaveBeenCalledTimes(1)
	} finally {
		await session.close()
	}
})
