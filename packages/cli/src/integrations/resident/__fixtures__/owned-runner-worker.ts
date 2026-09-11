import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRunFlags } from '../../../commands/run-flags.js'
import { ResidentCleanupUnconfirmedError } from '../lifecycle-errors.js'
import { runOwnedResident } from '../owned-runner.js'
import { startResidentRunner } from '../runner-launch.js'
import { publicRunner, reserveRunner } from '../runner-store.js'
import { lookupResident } from '../storage.js'

export interface OwnedRunnerWorkerOptions {
	readonly cwd: string
	readonly mode:
		| 'launcher'
		| 'race'
		| 'delayed'
		| 'ready-delay'
		| 'noncooperative'
		| 'reserved'
		| 'effect'
		| 'cleanup-failed'
		| 'cleanup-after-stop'
	readonly effectPath?: string
}

const options = JSON.parse(process.argv[2] ?? '') as OwnedRunnerWorkerOptions
function report(message: object): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send) return reject(new Error('Owned runner fixture requires IPC'))
		process.send(message, (error) => (error ? reject(error) : resolve()))
	})
}

let start!: () => void
let release!: () => void
const started = new Promise<void>((resolve) => {
	start = resolve
})
const released = new Promise<void>((resolve) => {
	release = resolve
})
process.on('message', (message) => {
	if (message === 'go') start()
	if (message === 'release') release()
})

let calls = 0
try {
	const resident = await lookupResident(options.cwd, 'default')
	if (!resident) throw new Error('Missing owned runner fixture resident')
	const state = await resident.agenda.read()
	if (!state) throw new Error('Missing owned runner fixture agenda')
	await report({ kind: 'ready' })
	await started
	if (options.mode === 'launcher') {
		const owner = await startResidentRunner({
			resident,
			ctx: { config: {}, formatter: { name: 'json', print() {}, info() {}, error() {} } },
			flags: parseRunFlags([]),
			maxSteps: 2,
			maxIdleMs: 25,
		})
		await report({ kind: 'launched', owner })
	} else {
		const owner = reserveRunner(resident, {
			mode: 'background',
			maxSteps: 2,
			pauseGeneration: state.pauseGeneration ?? 0,
		})
		await report({ kind: 'reserved', owner: publicRunner(owner) })
		if (options.mode === 'reserved') await new Promise<void>(() => {})
		if (options.mode === 'delayed') await released
		const result = await runOwnedResident({
			resident,
			owner,
			signal: new AbortController().signal,
			keepAlive: true,
			maxIdleMs: 25,
			pollIntervalMs: 5,
			ready: async (attached) => {
				await report({ kind: 'attached', owner: attached })
				if (options.mode === 'ready-delay') await released
			},
			step: async (pursuit, signal) => {
				calls++
				if (options.mode === 'cleanup-failed' || options.mode === 'cleanup-after-stop') {
					await report({ kind: 'entered', calls })
					if (options.mode === 'cleanup-after-stop') await released
					throw new ResidentCleanupUnconfirmedError([new Error('Synthetic resource did not drain')])
				}
				if (options.mode === 'effect') {
					await writeFile(options.effectPath ?? join(options.cwd, 'effect.txt'), 'applied once', {
						flag: 'wx',
					})
					await report({ kind: 'effect', claim: pursuit.state, calls })
					await new Promise<void>(() => {})
				}
				if (options.mode === 'noncooperative') {
					await report({ kind: 'entered', calls })
					await released
					await report({ kind: 'drained', calls, aborted: signal.aborted })
				}
				return { kind: 'complete', summary: 'Synthetic fixture verified' }
			},
		})
		await report({ kind: 'result', calls, result })
	}
	process.disconnect()
} catch (error) {
	await report({
		kind: 'failure',
		name: error instanceof Error ? error.name : typeof error,
		message: error instanceof Error ? error.message : String(error),
		calls,
	})
	process.exitCode = 1
	process.disconnect()
}
