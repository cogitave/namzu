import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type SidebarSnapshot, readSidebarSnapshot } from '../shared/sidebar-snapshot.js'

/**
 * The sidebar's last picture, kept beside the other per-profile files. The renderer reports a
 * new one whenever its lists settle or change; writes are gathered so a burst of changes costs
 * one atomic replace, and `flush` writes whatever is waiting on the way out. A missing or
 * damaged file reads as no snapshot, and the sidebar then starts from its placeholders.
 */
export class SidebarSnapshotStore {
	private snapshot: SidebarSnapshot | undefined
	private waiting: SidebarSnapshot | undefined
	private timer: ReturnType<typeof setTimeout> | undefined
	constructor(
		private readonly file: string,
		private readonly options: {
			delayMs?: number
			onError?: (error: unknown) => void
		} = {},
	) {
		try {
			this.snapshot = readSidebarSnapshot(JSON.parse(readFileSync(file, 'utf8')))
		} catch {
			// A first run has no file yet; a damaged one is replaced by the next write.
		}
	}
	get(): SidebarSnapshot | undefined {
		return this.snapshot
	}
	/** Takes a snapshot from the page; false when it is not one. */
	set(value: unknown): boolean {
		const next = readSidebarSnapshot(value)
		if (!next) return false
		if (JSON.stringify(next) === JSON.stringify(this.waiting ?? this.snapshot)) return true
		this.snapshot = next
		this.waiting = next
		if (!this.timer) this.timer = setTimeout(() => this.flush(), this.options.delayMs ?? 750)
		return true
	}
	flush(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		const pending = this.waiting
		this.waiting = undefined
		if (!pending) return
		try {
			mkdirSync(dirname(this.file), { recursive: true })
			writeFileSync(`${this.file}.tmp`, JSON.stringify(pending), { mode: 0o600 })
			renameSync(`${this.file}.tmp`, this.file)
		} catch (error) {
			this.options.onError?.(error)
		}
	}
}
