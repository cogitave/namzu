import { randomUUID } from 'node:crypto'
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
	EMERGENCY_DIR_NAME,
	EMERGENCY_EVENTS,
	EMERGENCY_SIGNALS,
} from '../../constants/emergency.js'
import type { EmergencySaveData } from '../../types/run/emergency.js'
import type { Logger } from '../../utils/logger.js'
import type { RunPersistence } from './persistence.js'

export class EmergencySaveManager {
	private static _instance: EmergencySaveManager | undefined
	private runRef: WeakRef<RunPersistence> | undefined
	private outputDir: string | undefined
	private signalHandlers: Map<string, () => void> = new Map()
	private log: Logger

	private constructor(log: Logger) {
		this.log = log
	}

	static instance(log?: Logger): EmergencySaveManager {
		if (!EmergencySaveManager._instance) {
			if (!log) {
				throw new Error('EmergencySaveManager requires a logger on first initialization')
			}
			EmergencySaveManager._instance = new EmergencySaveManager(log)
		}
		return EmergencySaveManager._instance
	}

	attach(runMgr: RunPersistence, outputDir: string, log: Logger): void {
		this.detach()
		this.runRef = new WeakRef(runMgr)
		this.outputDir = outputDir
		this.log = log.child({ component: 'EmergencySaveManager' })

		// Attaching a listener for SIGINT/SIGTERM/uncaughtException suppresses
		// Node's default termination behavior. After saving state we MUST
		// terminate explicitly, otherwise Ctrl+C leaves the process running
		// and uncaught errors stop propagating as crashes.
		for (const signal of EMERGENCY_SIGNALS) {
			const exitCode = signal === 'SIGINT' ? 130 : 143 // 128 + signal number
			const handler = (): void => {
				this.emergencySave(signal)
				process.exit(exitCode)
			}
			this.signalHandlers.set(signal, handler)
			process.on(signal, handler)
		}

		for (const event of EMERGENCY_EVENTS) {
			const handler = (): void => {
				this.emergencySave(event)
				process.exit(1)
			}
			this.signalHandlers.set(event, handler)
			process.on(event, handler)
		}

		this.log.info('Emergency save handlers attached', { outputDir })
	}

	detach(): void {
		for (const [signal, handler] of this.signalHandlers) {
			process.removeListener(signal, handler)
		}
		this.signalHandlers.clear()
		this.runRef = undefined
		this.outputDir = undefined
	}

	emergencySave(signal: string): void {
		const runMgr = this.runRef?.deref()
		if (!runMgr || !this.outputDir) {
			return
		}

		let tmpPath: string | undefined
		try {
			const snapshot = runMgr.toEmergencySnapshot(signal)

			const emergencyDir = join(this.outputDir, '..', EMERGENCY_DIR_NAME)
			mkdirSync(emergencyDir, { recursive: true })

			tmpPath = join(emergencyDir, `${snapshot.runId}.json.tmp.${randomUUID()}`)
			const finalPath = join(emergencyDir, `${snapshot.runId}.json`)

			writeFileSync(tmpPath, JSON.stringify(snapshot, null, '\t'), 'utf-8')
			renameSync(tmpPath, finalPath)
			tmpPath = undefined

			this.log.warn('Emergency save completed', {
				runId: snapshot.runId,
				signal,
				path: finalPath,
			})
		} catch (err) {
			if (tmpPath) {
				try {
					unlinkSync(tmpPath)
				} catch {
					// best-effort cleanup; swallowing here is intentional because we
					// are already in a crash-handling path and must not throw.
				}
			}
			try {
				this.log.error('Emergency save failed', {
					signal,
					error: err instanceof Error ? err.message : String(err),
				})
			} catch {
				// Logger itself failed — nothing more we can safely do.
			}
		}
	}

	static listSaves(baseDir: string): string[] {
		const emergencyDir = join(baseDir, EMERGENCY_DIR_NAME)
		try {
			return readdirSync(emergencyDir)
				.filter((f) => f.endsWith('.json'))
				.map((f) => join(emergencyDir, f))
		} catch {
			return []
		}
	}

	static loadSave(filePath: string): EmergencySaveData {
		const raw = readFileSync(filePath, 'utf-8')
		return JSON.parse(raw) as EmergencySaveData
	}

	static clearSave(filePath: string): void {
		unlinkSync(filePath)
	}
}
