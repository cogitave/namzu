import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import type { TenantId, TopicId } from '../../../types/ids/index.js'

const exec = promisify(execFile)
const DIST = join(import.meta.dirname, '../../../../dist')
const WORKER = join(import.meta.dirname, 'topic-cas-worker.mjs')
const TENANT = 'tnt_proc' as TenantId
const TOPIC = 'top_proc' as TopicId
const RECORDS = 160
const roots: string[] = []

afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true })
	roots.length = 0
})

interface WorkerResult {
	readonly won: readonly { readonly id: string; readonly mode?: string; readonly worker: string }[]
	readonly unexpected: readonly {
		readonly id: string
		readonly name?: string
		readonly message?: string
	}[]
}

async function race(rootDir: string, kind: 'state' | 'objective', prefix: string) {
	// Past process startup. Without this barrier one child can finish the
	// whole batch before another imports the SDK, which is sequencing, not a
	// process race. A batch makes the check-then-replace window observable.
	const barrier = String(Date.now() + 1_500)
	const outputs = await Promise.all(
		Array.from({ length: 3 }, (_, index) =>
			exec(
				process.execPath,
				[WORKER, DIST, rootDir, kind, prefix, String(RECORDS), `w${index}`, barrier],
				{ maxBuffer: 4 * 1024 * 1024 },
			),
		),
	)
	return outputs.map(({ stdout }) => JSON.parse(stdout.trim()) as WorkerResult)
}

function oneWinnerPerRecord(
	results: readonly WorkerResult[],
): Map<string, WorkerResult['won'][number]> {
	const byId = new Map<string, WorkerResult['won'][number][]>()
	for (const result of results) {
		expect(result.unexpected).toEqual([])
		for (const winner of result.won) {
			byId.set(winner.id, [...(byId.get(winner.id) ?? []), winner])
		}
	}
	expect(byId.size).toBe(RECORDS)
	expect([...byId.values()].filter((winners) => winners.length !== 1)).toEqual([])
	return new Map([...byId].map(([id, winners]) => [id, winners[0] as WorkerResult['won'][number]]))
}

describe('topic revisions arbitrate across processes', () => {
	it('admits one first state writer per topic and persists that exact winner', async () => {
		const rootDir = await mkdtemp(join(tmpdir(), 'namzu-topic-state-cas-proc-'))
		roots.push(rootDir)
		const prefix = 'top_state_proc_'

		const winners = oneWinnerPerRecord(await race(rootDir, 'state', prefix))
		const { DiskTopicStateStore } = await import('../state.js')
		const store = new DiskTopicStateStore({ rootDir })
		for (let i = 0; i < RECORDS; i++) {
			const id = `${prefix}${i}` as TopicId
			expect(await store.getState(id, TENANT)).toMatchObject({
				revision: 1,
				permissionMode: winners.get(id)?.mode,
			})
		}
	}, 60_000)

	it('debits one objective round per presented revision across processes', async () => {
		const rootDir = await mkdtemp(join(tmpdir(), 'namzu-objective-cas-proc-'))
		roots.push(rootDir)
		const prefix = 'obj_proc_'
		const { DiskTopicObjectiveStore } = await import('../objective.js')
		const seed = new DiskTopicObjectiveStore({ rootDir })
		for (let i = 0; i < RECORDS; i++) {
			await seed.createObjective(
				{ id: `${prefix}${i}`, topicId: TOPIC, objective: 'one debit', maxRounds: 3 },
				TENANT,
			)
		}

		oneWinnerPerRecord(await race(rootDir, 'objective', prefix))
		const reopened = new DiskTopicObjectiveStore({ rootDir })
		for (let i = 0; i < RECORDS; i++) {
			expect(await reopened.getObjective(`${prefix}${i}`, TENANT)).toMatchObject({
				revision: 2,
				roundsStarted: 1,
			})
		}
	}, 60_000)
})
