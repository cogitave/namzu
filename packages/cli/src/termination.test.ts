import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	DiskSessionLog,
	generateProjectId,
	generateSessionId,
	isLeaseLive,
	readSessionLease,
} from '@namzu/sdk'
import { afterAll, describe, expect, it } from 'vitest'

import { removeTempDir } from './__fixtures__/temp-dir.js'
import {
	type TerminationProcess,
	type TerminationSignal,
	handleTerminationSignals,
	resetTerminationForTests,
	signalExitCode,
	terminationInProgress,
} from './termination.js'

/**
 * The order is the contract: the leases are given back before anything else
 * runs, because the cleanup after it may be cut short and SIGKILL may follow.
 * One file: releasing leases is process-wide, and vitest isolates files.
 */

const roots: string[] = []
afterAll(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

class FakeProcess extends EventEmitter implements TerminationProcess {
	readonly pid = 4242
	readonly platform: NodeJS.Platform = 'linux'
	readonly kills: [number, TerminationSignal][] = []
	readonly exits: number[] = []
	override on(signal: TerminationSignal, listener: () => void): this {
		return super.on(signal, listener)
	}
	override removeListener(signal: TerminationSignal, listener: () => void): this {
		return super.removeListener(signal, listener)
	}
	kill(pid: number, signal: TerminationSignal): boolean {
		this.kills.push([pid, signal])
		return true
	}
	exit(code: number): never {
		this.exits.push(code)
		return undefined as never
	}
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20))
}

describe('handleTerminationSignals', () => {
	it('listens for SIGTERM, SIGHUP and SIGINT until disposed', () => {
		const proc = new FakeProcess()
		const handling = handleTerminationSignals({ process: proc })
		for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
			expect(proc.listenerCount(signal)).toBe(1)
		}
		handling.dispose()
		for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
			expect(proc.listenerCount(signal)).toBe(0)
		}
	})

	it('gives the leases back first, then runs the cleanup, then dies of the signal', async () => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), 'namzu-termination-'))
		roots.push(root)
		const sessionId = generateSessionId()
		const sessionDir = join(root, sessionId)
		const log = new DiskSessionLog({
			sessionId,
			file: join(root, `${sessionId}.jsonl`),
			sessionDir,
		})
		const lease = await log.claim({ holder: 'turn', ttlMs: 5 * 60_000 })
		if (lease === null) throw new Error('claim failed')
		await log.append(lease, {
			type: 'session_started',
			projectId: generateProjectId(),
			cwd: '/w',
			agent: { id: 'a', name: 'A' },
		})

		const proc = new FakeProcess()
		const order: string[] = []
		let finished: TerminationSignal | undefined
		const handling = handleTerminationSignals({
			process: proc,
			onFinished: (signal) => {
				finished = signal
			},
		})
		handling.onTerminate(async (signal) => {
			order.push(
				`cleanup ${signal}, lease live: ${isLeaseLive(await readSessionLease(sessionDir), Date.now())}`,
			)
		})
		handling.onTerminate(() => {
			order.push('second cleanup')
			throw new Error('a failed step does not stop the next one')
		})
		handling.onTerminate(() => {
			order.push('third cleanup')
		})

		proc.emit('SIGTERM')
		expect(terminationInProgress()).toBe('SIGTERM')
		// The command returning meanwhile does not take the exit from the handler.
		handling.dispose()
		for (let i = 0; i < 100 && finished === undefined; i++) await settle()

		expect(order).toEqual(['cleanup SIGTERM, lease live: false', 'second cleanup', 'third cleanup'])
		expect(finished).toBe('SIGTERM')
		expect(proc.listenerCount('SIGTERM')).toBe(0)
		expect(proc.exits).toEqual([])
	})

	it('re-raises the signal so the parent sees it, and exits with its status if that does not end it', async () => {
		resetTerminationForTests()
		const proc = new FakeProcess()
		handleTerminationSignals({ process: proc, leaseReleaseMs: 10 })
		proc.emit('SIGHUP')
		for (let i = 0; i < 100 && proc.kills.length === 0; i++) await settle()
		expect(proc.kills).toEqual([[4242, 'SIGHUP']])
		await new Promise((resolve) => setTimeout(resolve, 1_100))
		expect(proc.exits).toEqual([signalExitCode('SIGHUP')])
		expect(signalExitCode('SIGHUP')).toBe(129)
		expect(signalExitCode('SIGTERM')).toBe(143)
		expect(signalExitCode('SIGINT')).toBe(130)
	})

	it('exits at once on a second signal, and bounds a cleanup that hangs', async () => {
		resetTerminationForTests()
		const proc = new FakeProcess()
		let finished = false
		const handling = handleTerminationSignals({
			process: proc,
			cleanupMs: 200,
			onFinished: () => {
				finished = true
			},
		})
		handling.onTerminate(() => new Promise<void>(() => undefined))
		proc.emit('SIGINT')
		await settle()
		proc.emit('SIGINT')
		expect(proc.exits).toEqual([130])
		for (let i = 0; i < 50 && !finished; i++) await settle()
		expect(finished).toBe(true)
	})
})
