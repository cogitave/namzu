import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { SessionPaths } from '../../../session/paths.js'
import { DiskSessionLog } from '../../../store/session-log/index.js'
import type { SessionId } from '../../../types/ids/index.js'
import type { Checkpoint } from '../../../types/session/checkpoint.js'
import {
	generateCheckpointId,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../../utils/id.js'
import { locateSession, resolveSessionStorage } from '../session-storage.js'

// Spec §3.1: `checkpoints/` is inside the session's own directory, which for a
// child session is `<parent-session-dir>/subagents/<child-id>/`. A checkpoint
// scope names only the session id, so the store has to know where the session
// sits; otherwise every delegated child leaves a stray `<child-id>/` at the top
// of the project next to the root sessions.

let home: string
let paths: SessionPaths

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'namzu-child-checkpoints-'))
	paths = new SessionPaths({ home, slug: '-work' })
})

afterEach(async () => {
	await removeTempDirAsync(home)
})

async function writeOneCheckpoint(
	sessionLog: DiskSessionLog | undefined,
	sessionId: SessionId,
	parent?: SessionId,
) {
	const storage = await resolveSessionStorage({
		sessionId,
		...(parent ? { parentSessionId: parent } : {}),
		...(sessionLog ? { sessionLog } : {}),
		paths,
	})
	const scope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId,
		turnId: generateTurnId(),
	}
	const checkpoint: Checkpoint = {
		v: 1,
		kind: 'checkpoint',
		checkpointId: generateCheckpointId(),
		sessionId,
		turnId: scope.turnId,
		iteration: 1,
		throughSeq: 1,
		throughSha256: 'a'.repeat(64),
		tokenUsage: { ...EMPTY_TOKEN_USAGE },
		costInfo: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		guards: { iteration: 1, elapsedMs: 1 },
		review: { structuredAttempts: 0, answerAttempts: 0, nativeStructuredAttempts: 0 },
		turnCreatedAt: '2026-09-22T00:00:00.000Z',
		createdAt: '2026-09-22T00:00:01.000Z',
	} as Checkpoint
	await storage.checkpoints.write(scope, checkpoint)
	return checkpoint
}

describe('a child session keeps its checkpoints in its own directory', () => {
	it('places a grandchild log opened by its locator, and nothing lands at the top level', async () => {
		const root = generateSessionId()
		const child = generateSessionId()
		const grandchild = generateSessionId()
		const log = DiskSessionLog.at(paths, { sessionId: grandchild, ancestors: [root, child] })
		const checkpoint = await writeOneCheckpoint(log, grandchild)

		const expected = join(
			paths.sessionDir({ sessionId: grandchild, ancestors: [root, child] }),
			'checkpoints',
		)
		expect(await readdir(expected)).toEqual([`${checkpoint.checkpointId}.json`])
		expect(await readdir(paths.projectDir())).toEqual([root])
	})

	it('finds where the parent sits when the child is named without a log', async () => {
		const root = generateSessionId()
		const child = generateSessionId()
		const grandchild = generateSessionId()
		// The child's log exists under the root, as a manager would have placed it.
		const childLog = paths.sessionLog({ sessionId: child, ancestors: [root] })
		await mkdir(dirname(childLog), { recursive: true })
		await writeFile(childLog, '')

		expect(await locateSession(paths, grandchild, child)).toEqual({
			sessionId: grandchild,
			ancestors: [root, child],
		})
		await writeOneCheckpoint(undefined, grandchild, child)
		expect(await readdir(paths.projectDir())).toEqual([root])
	})

	it('finds the same checkpoints through a child log reopened by its path', async () => {
		const root = generateSessionId()
		const child = generateSessionId()
		const grandchild = generateSessionId()
		const locator = { sessionId: grandchild, ancestors: [root, child] }
		const written = await writeOneCheckpoint(DiskSessionLog.at(paths, locator), grandchild)

		// How the drain, abandonTurn and the CLI open a log: from the index's logPath.
		const logPath = paths.sessionLog(locator)
		const reopen = () =>
			new DiskSessionLog({
				sessionId: grandchild,
				file: logPath,
				sessionDir: logPath.replace(/\.jsonl$/, ''),
			})
		expect(reopen().locator).toEqual(locator)
		for (const parent of [undefined, child]) {
			const storage = await resolveSessionStorage({
				sessionId: grandchild,
				...(parent ? { parentSessionId: parent } : {}),
				sessionLog: reopen(),
				paths,
			})
			const scope = {
				tenantId: generateTenantId(),
				projectId: generateProjectId(),
				sessionId: grandchild,
				turnId: written.turnId,
			}
			expect((await storage.checkpoints.list(scope)).map((c) => c.checkpointId)).toEqual([
				written.checkpointId,
			])
		}

		// A new checkpoint written through the reopened log lands beside the first.
		await writeOneCheckpoint(reopen(), grandchild, child)
		expect(await readdir(join(paths.sessionDir(locator), 'checkpoints'))).toHaveLength(2)
		expect(await readdir(paths.projectDir())).toEqual([root])
	})

	it('places a log outside the layout under its named parent', async () => {
		const root = generateSessionId()
		const child = generateSessionId()
		await mkdir(paths.sessionDir({ sessionId: root }), { recursive: true })
		await writeFile(paths.sessionLog({ sessionId: root }), '')
		const elsewhere = join(home, 'elsewhere', 'log.jsonl')
		const log = new DiskSessionLog({
			sessionId: child,
			file: elsewhere,
			sessionDir: join(home, 'elsewhere', 'log'),
		})
		expect(log.locator).toBeUndefined()

		const checkpoint = await writeOneCheckpoint(log, child, root)
		expect(
			await readdir(join(paths.sessionDir({ sessionId: child, ancestors: [root] }), 'checkpoints')),
		).toEqual([`${checkpoint.checkpointId}.json`])
		expect((await readdir(paths.projectDir())).sort()).toEqual([root, `${root}.jsonl`].sort())
	})

	it('places a log outside the layout under its named parent even when its file name spells a place', async () => {
		const root = generateSessionId()
		await mkdir(paths.sessionDir({ sessionId: root }), { recursive: true })
		await writeFile(paths.sessionLog({ sessionId: root }), '')
		// Two shapes whose path alone reads as a place in some layout: a root
		// log (`<child-id>.jsonl`), and a child of a session this project
		// never had (`<other-id>/subagents/<child-id>.jsonl`). Neither file is
		// in this project, so neither place is the child's.
		const other = generateSessionId()
		for (const shape of ['root', 'nested'] as const) {
			const child = generateSessionId()
			const directory =
				shape === 'root' ? join(home, 'elsewhere') : join(home, 'elsewhere', other, 'subagents')
			const file = join(directory, `${child}.jsonl`)
			const log = new DiskSessionLog({
				sessionId: child,
				file,
				sessionDir: file.replace(/\.jsonl$/, ''),
			})
			expect(log.locator?.sessionId).toBe(child)

			const checkpoint = await writeOneCheckpoint(log, child, root)
			expect(
				await readdir(
					join(paths.sessionDir({ sessionId: child, ancestors: [root] }), 'checkpoints'),
				),
			).toEqual([`${checkpoint.checkpointId}.json`])
			expect((await readdir(paths.projectDir())).sort()).toEqual([root, `${root}.jsonl`].sort())
		}
	})

	it('takes a parent with no log anywhere to be a root session', async () => {
		const parent = generateSessionId()
		const child = generateSessionId()
		expect(await locateSession(paths, child, parent)).toEqual({
			sessionId: child,
			ancestors: [parent],
		})
		expect(await locateSession(paths, parent)).toEqual({ sessionId: parent })
	})
})
