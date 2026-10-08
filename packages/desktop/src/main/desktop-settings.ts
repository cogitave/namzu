import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
	DEFAULT_DESKTOP_SETTINGS,
	type DesktopSettings,
	desktopSettingsPatch,
	storedDesktopSettings,
} from '../shared/settings-protocol.js'

const FILE_VERSION = 1
const MAX_FILE_BYTES = 16 * 1024

export interface DesktopSettingsStoreOptions {
	file: string
	/** Called after a change was saved, with the new values; not called for a no-op. */
	onChange?: (settings: DesktopSettings, previous: DesktopSettings) => void
	/** A file that could not be read or written; the app keeps running on defaults. */
	onError?: (error: unknown, operation: 'read' | 'write') => void
}

/**
 * The preferences main acts on, in a file of their own beside `projects.json`. They are not a
 * key of `desktop-conversations.json`, whose strict validators would make an older app refuse
 * it. A missing, damaged or hand-edited file never blocks startup: bad entries read as the
 * default, and the next change rewrites the file whole.
 */
export class DesktopSettingsStore {
	private current: DesktopSettings

	constructor(private readonly options: DesktopSettingsStoreOptions) {
		this.current = this.read()
	}

	get(): DesktopSettings {
		return { ...this.current }
	}

	/** Validates, saves atomically, then notifies. A failed write leaves the values unchanged. */
	set(patch: unknown): DesktopSettings {
		const changes = desktopSettingsPatch(patch)
		const previous = this.current
		const next: DesktopSettings = { ...previous, ...changes }
		if (JSON.stringify(next) === JSON.stringify(previous)) return this.get()
		try {
			mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 })
			const temporary = `${this.options.file}.${process.pid}.${randomUUID()}.tmp`
			writeFileSync(temporary, JSON.stringify({ version: FILE_VERSION, ...next }), { mode: 0o600 })
			renameSync(temporary, this.options.file)
		} catch (error) {
			this.options.onError?.(error, 'write')
			throw new Error('Namzu could not save this setting. Check that its data folder is writable.')
		}
		this.current = next
		this.options.onChange?.({ ...next }, { ...previous })
		return this.get()
	}

	private read(): DesktopSettings {
		try {
			const source = readFileSync(this.options.file, 'utf8')
			if (source.length > MAX_FILE_BYTES) throw new Error('Settings file is too large.')
			return storedDesktopSettings(JSON.parse(source))
		} catch (error) {
			if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
				this.options.onError?.(error, 'read')
			return { ...DEFAULT_DESKTOP_SETTINGS }
		}
	}
}
