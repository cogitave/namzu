import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { EmergencySaveManager } from '../../../manager/run/emergency.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { prepareReplayState } from '../replay/prepare.js'

/**
 * A crash dump is removed once the run it belongs to has completed.
 *
 * `EmergencySaveManager.clearSave` existed with no caller, and the CLI turns
 * crash dumps on for every interactive turn, so each dump — the whole
 * conversation at the moment of the crash — stayed on disk for good. A run
 * that is resumed under its own id and completes has a newer record than the
 * dump; one that fails again does not, and keeps it.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function runWithDump(turn: MockTurn) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-dump-clear-'))
	dirs.push(root)
	const ids = {
		runId: generateRunId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	}
	const pathBuilder = new DefaultPathBuilder(join(root, 'state'))
	const runDir = pathBuilder.runDir(ids.projectId, ids.sessionId, ids.runId)
	const dump = EmergencySaveManager.savePathFor(runDir, ids.runId)
	await mkdir(join(dump, '..'), { recursive: true })
	await writeFile(dump, '{}')

	const run = await drainQuery({
		provider: new MockLLMProvider({ turns: [turn] }),
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: root,
		pathBuilder,
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 2 },
		...ids,
	})
	return { run, dump }
}

describe('a crash dump', () => {
	it('is removed when the run it belongs to completes', async () => {
		const { run, dump } = await runWithDump({ text: 'done' })
		expect(run.status).toBe('completed')
		expect(existsSync(dump)).toBe(false)
	})

	it('stays when the run fails again', async () => {
		const { run, dump } = await runWithDump({ error: { message: 'boom', status: 400 } })
		expect(run.status).not.toBe('completed')
		expect(existsSync(dump)).toBe(true)
	})
})

/**
 * A replay forked from a dump runs under a new id, so the cleanup above never
 * reaches the dump it continued. `prepareReplayState` names the dump, and the
 * replay run removes it when it completes.
 */
async function replayFromDump(turn: MockTurn) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-dump-replay-'))
	dirs.push(root)
	const ids = {
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	}
	const pathBuilder = new DefaultPathBuilder(join(root, 'state'))
	const runsDir = join(pathBuilder.sessionDir(ids.projectId, ids.sessionId), 'runs')
	const crashed = generateRunId()
	const dump = EmergencySaveManager.savePathFor(join(runsDir, crashed), crashed)
	await mkdir(join(dump, '..'), { recursive: true })
	await writeFile(
		dump,
		JSON.stringify({
			id: '0c9f0b9c-4a7e-4bb6-8d42-0c7a1d0e6f11',
			runId: crashed,
			messages: [{ role: 'user', content: 'go' }],
			tokenUsage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			currentIteration: 1,
			startedAt: 1,
			savedAt: 2,
			processSignal: 'SIGINT',
		}),
	)

	const prepared = await prepareReplayState({
		runId: crashed,
		baseDir: runsDir,
		emergencyDir: join(runsDir, 'emergency'),
		fromCheckpoint: 'emergency',
	})
	expect(prepared.emergencySavePath).toBe(dump)

	const run = await drainQuery({
		provider: new MockLLMProvider({ turns: [turn] }),
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: prepared.messages,
		workingDirectory: root,
		pathBuilder,
		supersedesEmergencySave: prepared.emergencySavePath,
		runConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 200_000,
			maxIterations: 2,
		},
		...ids,
	})
	return { run, dump, crashed }
}

describe('a crash dump a replay forked from', () => {
	it('is removed when the replay completes', async () => {
		const { run, dump, crashed } = await replayFromDump({ text: 'done' })
		expect(run.id).not.toBe(crashed)
		expect(run.status).toBe('completed')
		expect(existsSync(dump)).toBe(false)
	})

	it('stays when the replay fails', async () => {
		const { run, dump } = await replayFromDump({
			error: { message: 'boom', status: 400 },
		})
		expect(run.status).not.toBe('completed')
		expect(existsSync(dump)).toBe(true)
	})
})
