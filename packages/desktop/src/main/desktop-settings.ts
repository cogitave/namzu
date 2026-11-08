import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
	DEFAULT_DESKTOP_SETTINGS,
	type DesktopSettings,
	desktopSettingsPatch,
	storedDesktopSettings,
} from '../shared/settings-protocol.js'
import { parseJsonShape, readStoredFile } from './damaged-files.js'

const FILE_VERSION = 1
const MAX_FILE_BYTES = 16 * 1024

export interface DesktopSettingsStoreOptions {
	file: string
	/** Called after a change was saved, with the new values; not called for a no-op. */
	onChange?: (settings: DesktopSettings, previous: DesktopSettings) => void
	/** A file that could not be read or written; the app keeps running on defaults. */
	onError?: (error: unknown, operation: 'read' | 'write') => void
	/** The file was not valid settings; `movedAside` says whether it now sits at `<file>.bad`. */
	onDamaged?: (movedAside: boolean) => void
}

/**
 * The preferences main acts on, in a file of their own beside `projects.json`. They are not a
 * key of `desktop-conversations.json`, whose strict validators would make an older app refuse
 * it. A missing, damaged or hand-edited file never blocks startup: bad entries read as the
 * default, and the next change rewrites the file whole. A file that is not settings at all
 * (unparseable, oversized, not an object) is first moved aside as `.bad`, never overwritten.
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
		const value = readStoredFile({
			file: this.options.file,
			parse: (text) => parseJsonShape(text, 'object', MAX_FILE_BYTES),
			onDamaged: (movedAside) => this.options.onDamaged?.(movedAside),
			onUnreadable: (error) => this.options.onError?.(error, 'read'),
		})
		return value === undefined ? { ...DEFAULT_DESKTOP_SETTINGS } : storedDesktopSettings(value)
	}
}
