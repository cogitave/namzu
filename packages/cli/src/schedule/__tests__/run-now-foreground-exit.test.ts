/**
 * A foreground `schedule run-now` that does not return: its watchdog stops
 * the process, or a signal does. The run is recorded before the process
 * goes, so the job is not left with a run in progress nobody will settle.
 *
 * Giving the session leases back is process-wide and final
 * (`releaseHeldSessionLeases`), so it is stubbed here: these tests go on
 * starting sessions in the same process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import { createAgentSession } from '../../tui/agent.js'
import { runNowCommand } from '../commands/lifecycle.js'
import { foldHistory, readHistory } from '../store/history.js'
import { readState } from '../store/state.js'
import {
	DEEPSEEK,
	type Sandbox,
	completion,
	confirmedJob,
	recordingContext,
	sandbox,
} from './fixtures.js'

const released = vi.hoisted(() => ({ count: 0 }))
vi.mock('@namzu/sdk', async (original) => ({
	...(await original<typeof import('@namzu/sdk')>()),
	releaseHeldSessionLeases: async () => {
		released.count++
		return { released: 0, unfinished: 0 }
	},
}))

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
	released.count = 0
})
afterEach(() => {
	vi.unstubAllGlobals()
	__resetCliLoggerForTests()
	sb.cleanup()
})

const agent = {
	probeAgentSession: async () => ({
		preferences: null,
		needsRepickReason: null,
		detected: [DEEPSEEK],
		credentialGap: null,
	}),
	createAgentSession,
}

/** A provider that never answers; it gives up only when the turn is aborted. */
function hangingProvider(onAsk: () => void = () => {}): void {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>((_url, init) => {
			onAsk()
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
			})
		}),
	)
}

describe('a foreground run-now that does not return', () => {
	it('stopped by its watchdog, is recorded before the process goes, and does not block the next', async () => {
		const job = confirmedJob(sb, {
			permissions: { preset: 'read-only' },
			budget: { timeoutMs: 1_000 },
		})
		hangingProvider()
		let atExit: { active?: string; history?: string } | undefined
		const exited = new Promise<number>((resolve) => {
			void runNowCommand(recordingContext(), [job.name, '--home', sb.home], {
				agent,
				graceMs: 50,
				exit: (code) => {
					atExit = {
						active: readState(sb.paths, job.id).activeRun?.status,
						history: foldHistory(readHistory(sb.paths, job.id)).find((r) => r.kind === 'run')
							?.status,
					}
					resolve(code)
				},
			})
		})
		expect(await exited).toBe(1)
		expect(atExit).toEqual({ active: undefined, history: 'timed-out' })
		expect(readState(sb.paths, job.id).lastRun?.status).toBe('timed-out')

		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async () => completion()),
		)
		expect(await runNowCommand(recordingContext(), [job.name, '--home', sb.home], { agent })).toBe(
			0,
		)
	})

	it('interrupted by a signal, records the run as interrupted before exiting', async () => {
		const job = confirmedJob(sb, {
			permissions: { preset: 'read-only' },
			budget: { timeoutMs: 1_000 },
		})
		let asked: () => void = () => {}
		const reached = new Promise<void>((resolve) => {
			asked = resolve
		})
		hangingProvider(() => asked())
		const exited = new Promise<number>((resolve) => {
			void runNowCommand(recordingContext(), [job.name, '--home', sb.home], {
				agent,
				graceMs: 50,
				exit: resolve,
			})
		})
		await reached
		process.emit('SIGHUP')
		expect(await exited).toBe(129)
		expect(released.count).toBeGreaterThan(0)
		expect(readState(sb.paths, job.id).activeRun).toBeUndefined()
		const runs = foldHistory(readHistory(sb.paths, job.id)).filter((r) => r.kind === 'run')
		expect(runs[0]).toMatchObject({
			status: 'interrupted',
			reason: 'the run was interrupted (SIGHUP)',
		})
	})
})
