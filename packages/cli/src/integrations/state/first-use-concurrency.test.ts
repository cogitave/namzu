import { spawn } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { sessionDatabasePath, sessionStore } from '../sessions/database.js'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { openSessions } from '../sessions/store.js'
import { loadIdentity } from './identity.js'

const TSX_IMPORT = createRequire(import.meta.url).resolve('tsx')
const WORKER = fileURLToPath(new URL('./__fixtures__/first-use-worker.ts', import.meta.url))
const dirs: string[] = []

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-first-use-'))
	dirs.push(root)
	const stateRoot = join(root, 'home')
	const cwd = join(root, 'workspace')
	mkdirSync(stateRoot)
	mkdirSync(cwd)
	return { root, stateRoot, cwd }
}

async function initializeConcurrently(
	kind: 'identity' | 'topic',
	{ root, stateRoot, cwd }: ReturnType<typeof workspace>,
	recordPath: string,
): Promise<unknown[]> {
	const releasePath = join(root, 'release')
	const readers = Array.from({ length: 4 }, (_, index) => {
		const readyPath = join(root, `ready-${index}`)
		const child = spawn(
			process.execPath,
			['--import', TSX_IMPORT, WORKER, kind, cwd, stateRoot, recordPath, readyPath, releasePath],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		)
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => {
			stdout += chunk
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk
		})
		const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }))
			child.on('close', (code) => resolve({ code, stdout, stderr }))
		})
		return { child, readyPath, done }
	})
	try {
		const deadline = Date.now() + 20_000
		while (!readers.every(({ readyPath }) => existsSync(readyPath))) {
			if (readers.some(({ child }) => child.exitCode !== null) || Date.now() >= deadline) {
				throw new Error('first-use workers did not reach the absent-record barrier')
			}
			await setTimeout(10)
		}
		writeFileSync(releasePath, '')
		const results = await Promise.all(readers.map(({ done }) => done))
		return results.map(({ code, stdout, stderr }) => {
			expect(code, stderr).toBe(0)
			return JSON.parse(stdout)
		})
	} finally {
		for (const { child } of readers) {
			if (child.exitCode === null) child.kill()
		}
		await Promise.all(readers.map(({ done }) => done))
	}
}

describe('concurrent first use of CLI identities', () => {
	it('returns the same complete installation identity to every process', async () => {
		const paths = workspace()
		const recordPath = join(paths.stateRoot, 'identity.json')
		const results = await initializeConcurrently('identity', paths, recordPath)
		const persisted = JSON.parse(readFileSync(recordPath, 'utf8'))
		for (const result of results) expect(result).toEqual(persisted)
		expect(loadIdentity(paths.stateRoot)).toEqual(persisted)
		expect(readdirSync(paths.stateRoot)).toEqual(['identity.json'])
	}, 30_000)

	it('shares one SQLite project and deterministic topic across simultaneous first launches', async () => {
		const paths = workspace()
		loadIdentity(paths.stateRoot)
		const results = await initializeConcurrently(
			'topic',
			paths,
			sessionDatabasePath(paths.stateRoot),
		)
		for (const result of results) expect(result).toEqual(results[0])
		const handle = await openSessions(paths.cwd, { stateRoot: paths.stateRoot })
		expect(results[0]).toEqual({ projectId: handle.projectId, topicId: handle.topicId })
		expect(await sessionStore(paths.stateRoot, true).listProjects(handle.tenantId)).toHaveLength(1)
		expect(existsSync(join(paths.stateRoot, 'projects'))).toBe(false)
		expect(existsSync(join(handle.controlRoot, 'topic.json'))).toBe(false)
	}, 30_000)
})
