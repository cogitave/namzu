import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ResidentConflictError, generateProjectId, generateTenantId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import * as publication from '../state/immutable-json.js'
import {
	attachRunning,
	finishRunner,
	publicRunner,
	readRunner,
	readRunnerInstance,
	releaseRunner,
	reserveRunner,
} from './runner-store.js'
import { type CliResident, createResident } from './storage.js'

let directory: string
let stateRoot: string
let workspace: string
let resident: CliResident

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), 'namzu-runner-store-'))
	stateRoot = join(directory, 'state')
	workspace = join(directory, 'workspace')
	mkdirSync(stateRoot)
	mkdirSync(workspace)
	vi.stubEnv('NAMZU_HOME', stateRoot)
	resident = await createResident(workspace, 'default')
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(directory)
})

const options = { mode: 'background', maxSteps: 3, pauseGeneration: 0 } as const

function revisionPath(revision: number): string {
	return join(dirname(resident.artifactsRoot), 'runner', 'revisions', `${revision}.json`)
}

describe('resident runner ownership', () => {
	it('reads absent current and historical ownership without creating state', () => {
		const before = readdirSync(stateRoot, { recursive: true }).sort()
		expect(readRunner(resident)).toBeNull()
		expect(readRunnerInstance(resident, randomUUID())).toBeNull()
		expect(readdirSync(stateRoot, { recursive: true }).sort()).toEqual(before)
		expect(existsSync(dirname(revisionPath(1)))).toBe(false)
	})

	it('publishes private reservation, process attachment and drained evidence as immutable revisions', () => {
		const reserved = reserveRunner(resident, options)
		const firstBytes = readFileSync(revisionPath(1), 'utf8')
		expect(reserved).toMatchObject({
			version: 1,
			revision: 1,
			phase: 'reserved',
			...options,
			tenantId: resident.tenantId,
			projectId: resident.projectId,
			agentKey: resident.agentKey,
			cwd: resident.cwd,
			pid: null,
			port: null,
			endedAt: null,
			outcome: null,
		})
		expect(reserved.token).toMatch(/^[0-9a-f]{64}$/u)
		const running = attachRunning(resident, reserved, { pid: 123, port: 12_345 })
		expect(running).toMatchObject({
			...reserved,
			revision: 2,
			phase: 'running',
			pid: 123,
			port: 12_345,
		})
		const stopped = finishRunner(resident, running, 'limit')
		expect(stopped).toMatchObject({ revision: 3, phase: 'stopped', outcome: 'limit' })
		expect(stopped.endedAt).toEqual(expect.any(Number))
		expect(readRunner(resident)).toEqual(stopped)
		expect(readFileSync(revisionPath(1), 'utf8')).toBe(firstBytes)
		expect(readdirSync(dirname(revisionPath(1))).sort()).toEqual(['1.json', '2.json', '3.json'])
		if (process.platform !== 'win32') {
			expect(statSync(revisionPath(1)).mode & 0o777).toBe(0o600)
			expect(statSync(dirname(revisionPath(1))).mode & 0o777).toBe(0o700)
			expect(statSync(dirname(dirname(revisionPath(1)))).mode & 0o777).toBe(0o700)
		}
	})

	it('does not disclose the control token or extra fields in public status', () => {
		const reserved = reserveRunner(resident, options)
		const report = publicRunner({ ...reserved, extraSecret: reserved.token } as typeof reserved)
		expect(report).toMatchObject({ instanceId: reserved.instanceId, phase: 'reserved' })
		expect(report).not.toHaveProperty('token')
		expect(JSON.stringify(report)).not.toContain(reserved.token)
	})

	it('never takes over an occupied owner, even with an old timestamp or a missing process', () => {
		const reserved = reserveRunner(resident, options)
		const path = revisionPath(1)
		writeFileSync(path, JSON.stringify({ ...reserved, reservedAt: 0 }))
		expect(() => reserveRunner(resident, options)).toThrow(ResidentConflictError)
		const old = readRunner(resident)!
		attachRunning(resident, old, { pid: 2_147_483_647, port: 12_345 })
		expect(() => reserveRunner(resident, options)).toThrow(ResidentConflictError)
	})

	it('cannot attach, finish or release an old owner after exact recovery and a successor reservation', () => {
		const first = reserveRunner(resident, options)
		const running = attachRunning(resident, first, { pid: 123, port: 12_345 })
		expect(() => releaseRunner(resident, first)).toThrow(ResidentConflictError)
		const released = releaseRunner(resident, running)
		expect(released.phase).toBe('released')
		const successor = reserveRunner(resident, { ...options, mode: 'foreground' })
		expect(successor.revision).toBe(4)
		expect(successor.instanceId).not.toBe(first.instanceId)
		expect(successor.token).not.toBe(first.token)
		expect(() => attachRunning(resident, first, { pid: 123, port: 12_345 })).toThrow(
			ResidentConflictError,
		)
		expect(() => finishRunner(resident, running, 'late cleanup')).toThrow(ResidentConflictError)
		expect(() => releaseRunner(resident, running)).toThrow(ResidentConflictError)
		expect(readRunner(resident)).toEqual(successor)
		expect(readRunnerInstance(resident, first.instanceId)).toEqual(released)
		expect(readRunnerInstance(resident, first.instanceId)?.phase).not.toBe('stopped')
	})

	it('retains the original drained proof while a successor owns the runner', () => {
		const first = reserveRunner(resident, options)
		const stopped = finishRunner(resident, first, 'spawn failed before an executor started')
		const successor = reserveRunner(resident, options)
		expect(readRunnerInstance(resident, first.instanceId)).toEqual(stopped)
		expect(readRunnerInstance(resident, successor.instanceId)).toEqual(successor)
		expect(() => releaseRunner(resident, stopped)).toThrow(ResidentConflictError)
		expect(() => finishRunner(resident, stopped, 'duplicate')).toThrow(ResidentConflictError)
		expect(readRunner(resident)).toEqual(successor)
	})

	it('cannot publish stale cleanup when a successor appears after the last ownership read', () => {
		const first = reserveRunner(resident, options)
		const running = attachRunning(resident, first, { pid: 123, port: 12_345 })
		let successor: ReturnType<typeof reserveRunner> | undefined
		const originalPublish = publication.publishPrivateJsonIfAbsent
		vi.spyOn(publication, 'publishPrivateJsonIfAbsent').mockImplementationOnce((path, value) => {
			// The delayed finisher already checked revision 2. A recovery process
			// commits release 3 and reservation 4 before that finisher can publish.
			releaseRunner(resident, running)
			successor = reserveRunner(resident, options)
			originalPublish(path, value)
		})
		expect(() => finishRunner(resident, running, 'delayed cleanup')).toThrow(ResidentConflictError)
		expect(readRunner(resident)).toEqual(successor)
		expect(readRunnerInstance(resident, first.instanceId)?.phase).toBe('released')
		expect(readdirSync(dirname(revisionPath(1))).sort()).toEqual([
			'1.json',
			'2.json',
			'3.json',
			'4.json',
		])
	})

	it('requires the complete current record, not only a matching revision', () => {
		const reserved = reserveRunner(resident, options)
		expect(() => releaseRunner(resident, { ...reserved, instanceId: randomUUID() })).toThrow(
			ResidentConflictError,
		)
		expect(() => finishRunner(resident, { ...reserved, token: 'f'.repeat(64) }, 'done')).toThrow(
			ResidentConflictError,
		)
		expect(readRunner(resident)).toEqual(reserved)
	})

	it('isolates runner ownership across project, tenant and agent key', async () => {
		const owner = reserveRunner(resident, options)
		const otherWorkspace = join(directory, 'other-project')
		mkdirSync(otherWorkspace)
		for (const other of [
			await createResident(workspace, 'reviewer'),
			await createResident(otherWorkspace, 'default'),
		]) {
			expect(readRunner(other)).toBeNull()
			const separate = reserveRunner(other, options)
			expect(separate.instanceId).not.toBe(owner.instanceId)
			expect(() => releaseRunner(other, owner)).toThrow(ResidentConflictError)
		}
		expect(() => readRunner({ ...resident, tenantId: generateTenantId() })).toThrow(/scope/)
		expect(readRunner(resident)).toEqual(owner)
	})

	it.each([
		{ maxSteps: 0 },
		{ maxSteps: Number.POSITIVE_INFINITY },
		{ maxSteps: 1.5 },
		{ pauseGeneration: -1 },
		{ pauseGeneration: Number.MAX_SAFE_INTEGER + 1 },
		{ mode: 'unbounded' },
	])('rejects invalid limits before creating state: %j', (invalid) => {
		expect(() => reserveRunner(resident, { ...options, ...invalid } as typeof options)).toThrow(
			/limits or mode/,
		)
		expect(existsSync(dirname(revisionPath(1)))).toBe(false)
	})

	it.each([{ pid: 0 }, { pid: 1.5 }, { port: 0 }, { port: 65_536 }, { port: null }])(
		'refuses invalid background process metadata without advancing ownership: %j',
		(invalid) => {
			const first = reserveRunner(resident, options)
			expect(() => attachRunning(resident, first, { pid: 123, port: 12_345, ...invalid })).toThrow()
			expect(readRunner(resident)).toEqual(first)
		},
	)

	it.each([
		'{broken',
		'null',
		{ version: 2 },
		{ revision: 99 },
		{ projectId: generateProjectId() },
		{ tenantId: generateTenantId() },
		{ agentKey: 'different' },
		{ cwd: '/different' },
		{ token: 'short' },
		{ pid: 123 },
		{ phase: 'stopped' },
		{ extra: true },
	])('refuses corrupted ownership instead of inferring release: %j', (invalid) => {
		const first = reserveRunner(resident, options)
		const path = revisionPath(1)
		const corrupt = typeof invalid === 'string' ? invalid : JSON.stringify({ ...first, ...invalid })
		writeFileSync(path, corrupt)
		expect(() => readRunner(resident)).toThrow(/runner revision/)
		expect(() => reserveRunner(resident, options)).toThrow(/runner revision/)
		expect(readFileSync(path, 'utf8')).toBe(corrupt)
	})

	it('refuses symlink ownership paths and revision files', () => {
		reserveRunner(resident, options)
		const original = revisionPath(1)
		const target = join(directory, 'owner.json')
		renameSync(original, target)
		symlinkSync(target, original, 'file')
		expect(() => readRunner(resident)).toThrow(/revision entry/)
		const runnerPath = dirname(dirname(original))
		const moved = join(directory, 'moved-runner')
		renameSync(runnerPath, moved)
		symlinkSync(moved, runnerPath, process.platform === 'win32' ? 'junction' : 'dir')
		expect(() => readRunner(resident)).toThrow(/real directory/)
		expect(() => reserveRunner(resident, options)).toThrow(/real directory/)
	})

	it('does not quote private owner-file bytes in malformed JSON errors', () => {
		reserveRunner(resident, options)
		const privateBytes = 'deadbeefcafebabe'.repeat(4)
		writeFileSync(revisionPath(1), privateBytes)
		for (const read of [
			() => readRunner(resident),
			() => reserveRunner(resident, options),
			() => readRunnerInstance(resident, randomUUID()),
		]) {
			let failure: unknown
			try {
				read()
			} catch (error) {
				failure = error
			}
			expect(failure).toBeInstanceOf(Error)
			const message = (failure as Error).message
			expect(message).toContain(revisionPath(1))
			expect(message).toContain('invalid JSON')
			expect(message).not.toContain(privateBytes.slice(0, 8))
		}
	})

	it('ignores only incomplete publication candidates and refuses an exhausted revision counter', () => {
		const first = reserveRunner(resident, options)
		writeFileSync(`${revisionPath(2)}.candidate.${randomUUID()}`, '{unfinished')
		expect(readRunner(resident)).toEqual(first)
		const maximum = Number.MAX_SAFE_INTEGER
		writeFileSync(
			revisionPath(maximum),
			JSON.stringify({
				...first,
				revision: maximum,
				phase: 'stopped',
				endedAt: 1,
				outcome: 'done',
			}),
		)
		expect(() => reserveRunner(resident, options)).toThrow(/overflow/)
	})

	it('publishes one winner when independent processes reserve at the same barrier', async () => {
		const source = `
const { lookupResident } = await import(process.argv[1])
const { reserveRunner } = await import(process.argv[2])
const resident = await lookupResident(process.argv[3], 'default')
const go = new Promise(resolve => process.once('message', resolve))
process.send({ kind: 'ready' })
await go
try {
  const record = reserveRunner(resident, { mode: 'background', maxSteps: 3, pauseGeneration: 0 })
  process.send({ kind: 'reserved', instanceId: record.instanceId })
} catch (error) {
  process.send({ kind: 'refused', name: error.name, message: error.message })
}
process.disconnect()
`
		const workers = Array.from({ length: 4 }, () => {
			const child = spawn(
				process.execPath,
				[
					'--import',
					createRequire(import.meta.url).resolve('tsx'),
					'--input-type=module',
					'-e',
					source,
					new URL('./storage.ts', import.meta.url).href,
					new URL('./runner-store.ts', import.meta.url).href,
					workspace,
				],
				{
					stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
					env: { ...process.env, NAMZU_HOME: stateRoot },
				},
			)
			let errorOutput = ''
			child.stderr?.on('data', (chunk) => {
				errorOutput += String(chunk)
			})
			const messages: { kind: string; instanceId?: string; name?: string }[] = []
			const ready = new Promise<void>((resolveReady, reject) => {
				child.on('message', (raw) => {
					const message = raw as (typeof messages)[number]
					messages.push(message)
					if (message.kind === 'ready') resolveReady()
				})
				child.on('error', reject)
				child.on('exit', () => reject(new Error(`Worker exited before ready: ${errorOutput}`)))
			})
			const done = new Promise<number | null>((resolveDone) => {
				child.on('close', resolveDone)
			})
			return { child, ready, done, messages }
		})
		try {
			await Promise.all(workers.map((worker) => worker.ready))
			for (const worker of workers) worker.child.send('go')
			expect(await Promise.all(workers.map((worker) => worker.done))).toEqual([0, 0, 0, 0])
			const results = workers.flatMap((worker) => worker.messages)
			const winners = results.filter((result) => result.kind === 'reserved')
			expect(winners).toHaveLength(1)
			expect(results.filter((result) => result.name === 'ResidentConflictError')).toHaveLength(3)
			expect(readRunner(resident)?.instanceId).toBe(winners[0]?.instanceId)
			expect(readdirSync(dirname(revisionPath(1)))).toEqual(['1.json'])
		} finally {
			for (const worker of workers) {
				if (worker.child.exitCode === null) worker.child.kill()
			}
			await Promise.all(workers.map((worker) => worker.done))
		}
	})
})
