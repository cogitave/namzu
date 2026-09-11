import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DiskResidentAgenda, type ResidentAgendaStore, asTenantId } from '@namzu/sdk'
import { runResidentForeground } from '../foreground.js'

export interface ForegroundWorkerOptions {
	readonly root: string
	readonly tenantId: string
	readonly mode: 'idle' | 'cooperative' | 'effect' | 'run' | 'control'
	readonly control?: 'pause' | 'resume' | 'pause-resume'
	readonly pursuitId?: string
}

const options = JSON.parse(process.argv[2] ?? '') as ForegroundWorkerOptions
const agenda = new DiskResidentAgenda(options.root, {
	tenantId: asTenantId(options.tenantId),
	agentKey: 'foreground-process',
})

function report(message: object): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send) return reject(new Error('Foreground worker requires IPC'))
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

try {
	await report({ kind: 'ready' })
	await started
	if (options.mode === 'control') {
		const initial = await agenda.read()
		if (!initial) throw new Error('Missing control agenda')
		let current = initial
		if (options.control !== 'resume') current = await agenda.setPaused(current, true)
		if (options.control !== 'pause') current = await agenda.setPaused(current, false)
		await report({
			kind: 'controlled',
			paused: current.paused,
			generation: current.pauseGeneration,
		})
	} else {
		let reads = 0
		const visible: ResidentAgendaStore = {
			read: async () => {
				const count = ++reads
				if (options.mode === 'idle' && count === 3) {
					// Hold the first monitor read until another process completed both
					// pause and resume: checking only the boolean must miss this pause.
					await report({ kind: 'control-waiting' })
					await released
				}
				const state = await agenda.read()
				if (options.pursuitId && count === 2) {
					await report({ kind: 'admission-ready', pursuitId: options.pursuitId })
					await released
				}
				// Give contenders different candidates. Claims still use the complete
				// real disk agenda, whose admission must serialize both processes.
				return state && options.pursuitId
					? { ...state, pursuits: state.pursuits.filter((p) => p.id === options.pursuitId) }
					: state
			},
			create: (...args) => agenda.create(...args),
			add: (...args) => agenda.add(...args),
			setPaused: (...args) => agenda.setPaused(...args),
			wake: (...args) => agenda.wake(...args),
			execution: (...args) => agenda.execution(...args),
			executionAt: (...args) => agenda.executionAt(...args),
		}
		let calls = 0
		const result = await runResidentForeground({
			agenda: visible,
			signal: new AbortController().signal,
			maxSteps: 1,
			maxIdleMs: 60_000,
			pollIntervalMs: 5,
			step: async (pursuit, signal) => {
				calls++
				if (options.mode === 'effect') {
					await writeFile(join(options.root, 'effect.txt'), 'applied once', { flag: 'wx' })
					await report({ kind: 'effect', claim: pursuit.state, calls })
					await new Promise<void>(() => {})
				}
				if (options.mode === 'cooperative') {
					const abort = new Promise<void>((resolve) => {
						if (signal.aborted) resolve()
						else signal.addEventListener('abort', () => resolve(), { once: true })
					})
					await report({ kind: 'entered', pursuitId: pursuit.id, calls })
					await abort
					await sleep(10)
					await report({ kind: 'drained', aborted: signal.aborted })
				}
				return { kind: 'complete', summary: 'Fixture verified' }
			},
		})
		await report({ kind: 'result', result, calls })
	}
	process.disconnect()
} catch (error) {
	await report({ kind: 'failure', message: error instanceof Error ? error.message : String(error) })
	process.exitCode = 1
	process.disconnect()
}
