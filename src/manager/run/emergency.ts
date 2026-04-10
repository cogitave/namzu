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
	private sessionRef: WeakRef<RunPersistence> | undefined
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

	attach(sessionMgr: RunPersistence, outputDir: string, log: Logger): void {
		this.detach()
		this.sessionRef = new WeakRef(sessionMgr)
		this.outputDir = outputDir
		this.log = log.child({ component: 'EmergencySaveManager' })

		for (const signal of EMERGENCY_SIGNALS) {
			const handler = (): void => {
				this.emergencySave(signal)
			}
			this.signalHandlers.set(signal, handler)
			process.on(signal, handler)
		}

		for (const event of EMERGENCY_EVENTS) {
			const handler = (): void => {
				this.emergencySave(event)
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
		this.sessionRef = undefined
		this.outputDir = undefined
	}

	emergencySave(signal: string): void {
		const sessionMgr = this.sessionRef?.deref()
		if (!sessionMgr || !this.outputDir) {
			return
		}

		const snapshot = sessionMgr.toEmergencySnapshot(signal)

		const emergencyDir = join(this.outputDir, '..', EMERGENCY_DIR_NAME)
		mkdirSync(emergencyDir, { recursive: true })

		const tmpPath = join(emergencyDir, `${snapshot.runId}.json.tmp`)
		const finalPath = join(emergencyDir, `${snapshot.runId}.json`)

		writeFileSync(tmpPath, JSON.stringify(snapshot, null, '\t'), 'utf-8')
		renameSync(tmpPath, finalPath)

		this.log.warn('Emergency save completed', {
			runId: snapshot.runId,
			signal,
			path: finalPath,
		})
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
