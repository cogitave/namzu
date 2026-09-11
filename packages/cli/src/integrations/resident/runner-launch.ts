import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import type { RunFlags } from '../../commands/run-flags.js'
import type { CommandContext } from '../../commands/types.js'
import { queryRunner } from './runner-control.js'
import {
	type RunnerRecord,
	finishRunner,
	publicRunner,
	readRunner,
	readRunnerInstance,
	reserveRunner,
} from './runner-store.js'
import type { CliResident } from './storage.js'

export interface ResidentWorkerLaunch {
	readonly version: 1
	readonly cwd: string
	readonly agentKey: string
	readonly instanceId: string
	readonly config: CommandContext['config']
	readonly flags: RunFlags
	readonly maxIdleMs: number
}

/** Launch the same installation with no terminal streams or on-disk credentials/config. */
export async function startResidentRunner(options: {
	readonly resident: CliResident
	readonly ctx: CommandContext
	readonly flags: RunFlags
	readonly maxSteps: number
	readonly maxIdleMs: number
}) {
	const { resident } = options
	const existing = readRunner(resident)
	if (existing && (existing.phase === 'reserved' || existing.phase === 'running'))
		throw new Error(
			`Runner ${existing.instanceId} already owns this resident. Use resident status or stop; a second start cannot reset its limit.`,
		)
	const agenda = await resident.agenda.read()
	if (!agenda || agenda.paused || agenda.pursuits.some((p) => p.state.phase === 'running'))
		throw new Error('Starting requires open admission and no unresolved pursuit claims.')
	const owner = reserveRunner(resident, {
		mode: 'background',
		maxSteps: options.maxSteps,
		pauseGeneration: agenda.pauseGeneration ?? 0,
	})
	const source = import.meta.url.endsWith('.ts')
	const worker = new URL(`./runner-worker.${source ? 'ts' : 'js'}`, import.meta.url)
	const launch: ResidentWorkerLaunch = {
		version: 1,
		cwd: resident.cwd,
		agentKey: resident.agentKey,
		instanceId: owner.instanceId,
		config: options.ctx.config,
		flags: options.flags,
		maxIdleMs: options.maxIdleMs,
	}
	let child: ReturnType<typeof fork>
	try {
		child = fork(worker, [], {
			cwd: resident.cwd,
			env: { ...process.env, NAMZU_HOME: resident.root },
			detached: true,
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			execArgv: source ? ['--import', createRequire(import.meta.url).resolve('tsx')] : [],
		})
	} catch (error) {
		finishRunner(resident, owner, 'launch_failed')
		throw error
	}
	return await new Promise<ReturnType<typeof publicRunner>>((resolve, reject) => {
		let settled = false
		const finish = (error?: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.removeListener('message', message)
			child.removeListener('exit', exited)
			// Keep the error listener: asynchronous IPC teardown must not crash the launcher.
			if (child.connected) child.disconnect()
			child.unref()
			if (error) reject(error)
			else {
				try {
					const current = readRunnerInstance(resident, owner.instanceId)
					if (!current) throw new Error('Runner startup receipt disappeared.')
					resolve(publicRunner(current))
				} catch (readError) {
					reject(readError)
				}
			}
		}
		const message = (raw: unknown) => {
			if (!raw || typeof raw !== 'object') return
			const value = raw as Record<string, unknown>
			if (value.instanceId !== owner.instanceId) return
			if (value.kind === 'error') {
				finish(
					new Error(typeof value.message === 'string' ? value.message : 'Runner startup failed.'),
				)
			} else if (value.kind === 'ready') {
				// The child will not admit a model step before this explicit handoff.
				child.send({ kind: 'go', instanceId: owner.instanceId }, (error) =>
					finish(error ?? undefined),
				)
			}
		}
		const exited = () =>
			finish(
				new Error(
					'Resident worker exited before startup was acknowledged. Inspect resident status.',
				),
			)
		const timer = setTimeout(
			() =>
				finish(
					new Error(
						'Resident startup was not acknowledged. Ownership is retained; inspect resident status before retrying.',
					),
				),
			15_000,
		)
		child.on('message', message)
		child.once('exit', exited)
		child.on('error', (error) => {
			if (!child.pid) {
				try {
					finishRunner(resident, owner, 'launch_failed')
				} catch {
					/* Keep the exact-owner conflict visible in status. */
				}
			}
			finish(error)
		})
		child.send(launch, (error) => {
			if (error) finish(error)
		})
	})
}

export async function residentRunnerStatus(resident: CliResident) {
	const record = readRunner(resident)
	if (!record) return { owner: null, live: null }
	return {
		owner: publicRunner(record),
		live: record.phase === 'running' ? await queryRunner(record, 'status') : null,
	}
}

/** Caller durably closes admission first. No signals are sent to recorded PIDs. */
export async function stopResidentRunner(
	resident: CliResident,
	options: { readonly owner: RunnerRecord | null; readonly waitMs?: number },
) {
	const record = options.owner
	const waitMs = options.waitMs ?? 5_000
	if (!record) return { status: 'absent' as const, owner: null }
	if (record.phase === 'stopped') return { status: 'drained' as const, owner: publicRunner(record) }
	if (record.phase === 'released')
		return { status: 'unconfirmed' as const, owner: publicRunner(record) }
	if (record.phase === 'running') await queryRunner(record, 'stop')
	const deadline = Date.now() + waitMs
	while (true) {
		const current = readRunnerInstance(resident, record.instanceId)
		if (current?.phase === 'stopped')
			return { status: 'drained' as const, owner: publicRunner(current) }
		if (!current || current.phase === 'released' || Date.now() >= deadline)
			return { status: 'unconfirmed' as const, owner: current ? publicRunner(current) : null }
		await sleep(Math.min(50, Math.max(1, deadline - Date.now())))
	}
}
