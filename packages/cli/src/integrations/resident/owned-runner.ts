import type { ResidentContextualStep, ResidentHostResult } from '@namzu/sdk'
import { runResidentForeground } from './foreground.js'
import { ResidentCleanupUnconfirmedError } from './lifecycle-errors.js'
import { createRunnerControlServer } from './runner-control.js'
import {
	type RunnerRecord,
	attachRunning,
	finishRunner,
	publicRunner,
	readRunner,
} from './runner-store.js'
import type { CliResident } from './storage.js'

export interface OwnedResidentOptions {
	readonly resident: CliResident
	readonly owner: RunnerRecord
	readonly step: ResidentContextualStep
	readonly signal: AbortSignal
	readonly keepAlive: boolean
	readonly maxIdleMs: number
	/** Readiness means control and durable ownership are installed, not model availability. */
	readonly ready?: (owner: ReturnType<typeof publicRunner>, signal: AbortSignal) => Promise<void>
	readonly pollIntervalMs?: number
}

/** Keep ownership until the SDK invocation, callback cleanup and control server drain. */
export async function runOwnedResident(options: OwnedResidentOptions): Promise<ResidentHostResult> {
	const { resident } = options
	let owner = options.owner
	let phase: 'starting' | 'idle' | 'working' | 'stopping' = 'starting'
	let stepsStarted = 0
	const controller = new AbortController()
	const signal = AbortSignal.any([options.signal, controller.signal])
	const abort = () => {
		phase = 'stopping'
		controller.abort(new Error('Resident runner stop requested.'))
	}
	const checkControl = async () => {
		const current = readRunner(resident)
		if (current?.instanceId !== owner.instanceId || current.phase !== 'running')
			throw new Error('Resident runner ownership changed; this invocation is fenced.')
	}
	let server: Awaited<ReturnType<typeof createRunnerControlServer>> | undefined
	let outcome = 'startup_failed'
	let cleanupConfirmed = true
	try {
		signal.throwIfAborted()
		const state = await resident.agenda.read()
		if (!state || state.paused || (state.pauseGeneration ?? 0) !== owner.pauseGeneration)
			throw new Error(
				'Resident admission changed before runner startup. Resume and start a new invocation.',
			)
		if (state.pursuits.some((p) => p.state.phase === 'running'))
			throw new Error('Inspect and reconcile unresolved work before starting a runner.')
		server = await createRunnerControlServer({
			instanceId: owner.instanceId,
			token: owner.token,
			getStatus: () => ({
				pid: process.pid,
				phase: signal.aborted ? 'stopping' : phase,
				stepsStarted,
			}),
			onStop: abort,
		})
		owner = attachRunning(resident, owner, { pid: process.pid, port: server.port })
		await checkControl()
		await options.ready?.(publicRunner(owner), signal)
		signal.throwIfAborted()
		phase = 'idle'
		const result = await runResidentForeground({
			agenda: resident.agenda,
			step: async (...args) => {
				phase = 'working'
				stepsStarted++
				try {
					return await options.step(...args)
				} catch (error) {
					// The SDK host turns aborted callbacks into a cancelled result.
					// Latch failed drainage before that conversion can hide it.
					if (error instanceof ResidentCleanupUnconfirmedError) cleanupConfirmed = false
					throw error
				} finally {
					phase = signal.aborted ? 'stopping' : 'idle'
				}
			},
			signal,
			maxSteps: owner.maxSteps,
			maxIdleMs: options.maxIdleMs,
			keepAlive: options.keepAlive,
			expectedPauseGeneration: owner.pauseGeneration,
			checkControl,
			...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
		})
		outcome = result.status
		return result
	} catch (error) {
		if (error instanceof ResidentCleanupUnconfirmedError) cleanupConfirmed = false
		outcome = signal.aborted ? 'cancelled' : 'failed'
		throw error
	} finally {
		phase = 'stopping'
		// A stopped receipt is a drainage acknowledgement, never a PID-liveness guess.
		await server?.close()
		if (cleanupConfirmed) finishRunner(resident, owner, outcome)
	}
}
