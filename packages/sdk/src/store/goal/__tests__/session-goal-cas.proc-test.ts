import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

import type { SessionId } from '../../../types/ids/index.js'
import { generateTenantId, generateTopicId } from '../../../utils/id.js'
import { DiskSessionStore } from '../../session/disk.js'
import { DiskSessionGoalStore } from '../index.js'

const exec = promisify(execFile)
const DIST = join(import.meta.dirname, '../../../../dist')
const WORKER = join(import.meta.dirname, 'session-goal-cas-worker.mjs')
const RECORDS = 96
const roots: string[] = []

afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true })
	roots.length = 0
})

interface WorkerResult {
	readonly won: readonly {
		readonly sessionId: SessionId
		readonly worker: string
	}[]
	readonly unexpected: readonly {
		readonly sessionId: SessionId
		readonly message: string
	}[]
}

it('admits one exact goal-revision writer per Session across processes', async () => {
	const rootDir = await mkdtemp(join(tmpdir(), 'namzu-session-goal-cas-proc-'))
	roots.push(rootDir)
	const tenantId = generateTenantId()
	const sessions = new DiskSessionStore({ rootDir })
	const project = await sessions.createProject({ tenantId, name: 'goal CAS' }, tenantId)
	const goals = new DiskSessionGoalStore({ rootDir, sessions })
	const sessionIds: SessionId[] = []
	for (let index = 0; index < RECORDS; index += 1) {
		const session = await sessions.createSession(
			{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
			tenantId,
		)
		sessionIds.push(session.id)
		await goals.createGoal({ sessionId: session.id, objective: 'seed' }, tenantId)
	}

	const barrier = String(Date.now() + 1_500)
	const outputs = await Promise.all(
		Array.from({ length: 3 }, (_, index) =>
			exec(
				process.execPath,
				[WORKER, DIST, rootDir, tenantId, JSON.stringify(sessionIds), `w${index}`, barrier],
				{ maxBuffer: 4 * 1024 * 1024 },
			),
		),
	)
	const results = outputs.map(({ stdout }) => JSON.parse(stdout.trim()) as WorkerResult)
	const winners = new Map<SessionId, WorkerResult['won'][number][]>()
	for (const result of results) {
		expect(result.unexpected).toEqual([])
		for (const winner of result.won) {
			winners.set(winner.sessionId, [...(winners.get(winner.sessionId) ?? []), winner])
		}
	}
	for (const sessionId of sessionIds) {
		const forSession = winners.get(sessionId) ?? []
		expect(forSession).toHaveLength(1)
		expect(await goals.getGoal(sessionId, tenantId)).toMatchObject({
			revision: 2,
			objective: `winner:${forSession[0]?.worker}`,
		})
	}
}, 60_000)
