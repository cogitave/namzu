/**
 * The interface-state store: one file in the main process that keeps what a window should look
 * like when it comes back. The renderer reads a snapshot before its first paint and writes through
 * IPC, so a restored window is never first drawn with defaults.
 *
 * Writes are atomic (a temporary file, then a rename), debounced, and flushed on quit and when a
 * renderer dies. How the last run ended is recorded: `cleanShutdown` is false from start until a
 * quit has flushed, so a crash or a kill is told from a quit. Facts about a conversation (its last
 * context figure, history, outputs) are not kept here: the session log owns those.
 */

import { defineOf } from '../../shared/state-registry.js'
import {
	STATE_FILE_VERSION,
	type StateEntry,
	type StateFile,
	emptyStateFile,
	legacyEntries,
	parseStateFile,
} from './migrate.js'

/** The disk, as the store needs it. A test passes a fake that can fail between the two steps. */
export interface StateFs {
	read(file: string): string | undefined
	/** Writes the whole text to `file`; the store never calls it on the live file. */
	write(file: string, text: string): void
	rename(from: string, to: string): void
	mkdirp(dir: string): void
}

/** How the previous run ended, as far as the file can tell. */
export type CloseState = 'first-run' | 'clean' | 'crash'

export interface StateStoreOptions {
	readonly file: string
	readonly fs: StateFs
	readonly now: () => number
	/** Runs `run` after `ms`; returns a way to cancel it. Injected so no test waits on a clock. */
	readonly schedule: (run: () => void, ms: number) => () => void
	readonly onError?: (error: unknown) => void
}

export const DEBOUNCE_MS = 500

export type SetResult = 'ok' | 'unknown-key' | 'too-large' | 'read-only'

export interface StateChange {
	readonly key: string
	/** `null` when the key was removed. */
	readonly value: string | null
}

export class StateStore {
	private entries: Record<string, StateEntry> = {}
	private legacyImported = false
	private dirty = false
	private cancel: (() => void) | undefined
	private readOnly = false
	private writes = 0
	private readonly listeners = new Set<(change: StateChange) => void>()
	/** How the previous run ended. */
	readonly closeState: CloseState

	constructor(private readonly options: StateStoreOptions) {
		const { fs, file } = options
		let text: string | undefined
		try {
			text = fs.read(file)
		} catch (error) {
			options.onError?.(error)
		}
		let closeState: CloseState = 'first-run'
		if (text !== undefined) {
			const parsed = parseStateFile(text, options.now())
			if (parsed.kind === 'ok') {
				this.entries = parsed.file.entries
				this.legacyImported = parsed.file.legacyImported
				closeState = parsed.file.cleanShutdown ? 'clean' : 'crash'
			} else if (parsed.kind === 'newer') {
				// A newer Namzu wrote this: show nothing of it, and never write over it.
				this.readOnly = true
				closeState = 'clean'
			} else {
				// Keep the unreadable file beside the new one instead of losing it.
				try {
					fs.rename(file, `${file}.unreadable`)
				} catch (error) {
					options.onError?.(error)
				}
				closeState = 'crash'
			}
		}
		this.closeState = closeState
		if (closeState === 'crash') this.resetSoftKeys()
		// From here until a quit flushes, the file says the run is not over.
		this.write(false)
	}

	/** After a crash a selection made just before it may be what crashed: those keys start over. */
	private resetSoftKeys(): void {
		for (const key of Object.keys(this.entries)) {
			if (defineOf(key)?.restore === 'soft') delete this.entries[key]
		}
	}

	get(key: string): string | undefined {
		return this.entries[key]?.v
	}

	/** Everything stored, as the plain strings a `Storage` would hold. */
	snapshot(): Record<string, string> {
		const out: Record<string, string> = {}
		for (const [key, entry] of Object.entries(this.entries)) out[key] = entry.v
		return out
	}

	set(key: string, value: string): SetResult {
		const def = defineOf(key)
		if (!def || typeof value !== 'string') return 'unknown-key'
		if (Buffer.byteLength(value) > def.maxBytes) {
			this.options.onError?.(
				new Error(`State key ${def.id} is over its size cap and was not saved.`),
			)
			return 'too-large'
		}
		if (this.readOnly) return 'read-only'
		if (this.entries[key]?.v === value) return 'ok'
		this.entries[key] = { v: value, t: this.options.now() }
		this.evict(key)
		this.touch()
		this.emit({ key, value })
		return 'ok'
	}

	remove(key: string): void {
		if (!(key in this.entries) || this.readOnly) return
		delete this.entries[key]
		this.touch()
		this.emit({ key, value: null })
	}

	/** Keeps a family within its entry cap by dropping what was written longest ago. */
	private evict(just: string): void {
		const def = defineOf(just)
		if (!def?.maxEntries) return
		const same = Object.entries(this.entries).filter(([key]) => defineOf(key) === def)
		if (same.length <= def.maxEntries) return
		const oldest = same
			.filter(([key]) => key !== just)
			.sort((x, y) => x[1].t - y[1].t)
			.slice(0, same.length - def.maxEntries)
		for (const [key] of oldest) {
			delete this.entries[key]
			this.emit({ key, value: null })
		}
	}

	/**
	 * Copies what the renderer kept in `localStorage` before this store existed. Done once: a key the
	 * store already holds is newer and wins, and the marker stops a second window repeating it.
	 * Returns what the caller may now delete from `localStorage`.
	 */
	importLegacy(raw: unknown): { imported: number; deletable: string[] } {
		const found = legacyEntries(raw)
		const deletable = Object.keys(found)
		if (this.legacyImported || this.readOnly)
			return { imported: 0, deletable: this.readOnly ? [] : deletable }
		let imported = 0
		for (const [key, value] of Object.entries(found)) {
			if (key in this.entries) continue
			this.entries[key] = { v: value, t: this.options.now() }
			this.evict(key)
			imported += 1
		}
		this.legacyImported = true
		this.touch()
		return { imported, deletable }
	}

	/** Drops every key that belongs to a conversation, when the conversation is removed. */
	forgetConversation(conversationId: string): number {
		if (!conversationId || this.readOnly) return 0
		let dropped = 0
		for (const key of Object.keys(this.entries)) {
			const def = defineOf(key)
			if (def?.scope !== 'conversation' || def.ownerOf?.(key) !== conversationId) continue
			delete this.entries[key]
			dropped += 1
			this.emit({ key, value: null })
		}
		if (dropped > 0) this.touch()
		return dropped
	}

	onChange(listener: (change: StateChange) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emit(change: StateChange): void {
		for (const listener of this.listeners) listener(change)
	}

	private touch(): void {
		this.dirty = true
		if (this.cancel) return
		this.cancel = this.options.schedule(() => {
			this.cancel = undefined
			this.flush()
		}, DEBOUNCE_MS)
	}

	/** Writes pending changes now. Called on quit, on a window's close and when a renderer dies. */
	flush(): void {
		if (this.cancel) {
			this.cancel()
			this.cancel = undefined
		}
		if (!this.dirty) return
		this.write(false)
	}

	/** The last step of a quit: flush everything and record that the run ended cleanly. */
	markCleanShutdown(): void {
		if (this.cancel) {
			this.cancel()
			this.cancel = undefined
		}
		this.write(true)
	}

	private write(clean: boolean): void {
		if (this.readOnly) return
		const { fs, file } = this.options
		const body: StateFile = {
			...emptyStateFile(this.options.now()),
			version: STATE_FILE_VERSION,
			cleanShutdown: clean,
			legacyImported: this.legacyImported,
			entries: this.entries,
		}
		const temporary = `${file}.${this.writes++}.tmp`
		try {
			fs.mkdirp(dirOf(file))
			fs.write(temporary, JSON.stringify(body))
			fs.rename(temporary, file)
			this.dirty = false
		} catch (error) {
			// The old file is untouched; what is in memory is tried again at the next change.
			this.options.onError?.(error)
		}
	}
}

function dirOf(file: string): string {
	const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
	return slash > 0 ? file.slice(0, slash) : '.'
}
