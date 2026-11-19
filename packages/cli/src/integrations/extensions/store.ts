import { randomBytes, randomUUID } from 'node:crypto'
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { PackageFile } from './package.js'

/**
 * Per-user files of the extension platform, under `$NAMZU_HOME/extensions`. One writer at a time
 * (the supervisor that holds the lock); every write is atomic (temp file in the same folder, fsync,
 * rename). The host never reads inside an extension's `data/` folder.
 */

export interface ExtensionState {
	schema: 1
	id: string
	activeVersion: string | null
	stagedVersion?: string
	enabled: boolean
	firstAddedAt: string
	/** The latest time this host has seen: the clock rolled-back guard for licences. */
	lastSeenAt: number
	dev: boolean
	keyId: string
	/** `failed`: the restart cap was hit and the person has to start it again. */
	failed?: string
	/** The person's "Start when I sign in" switch, per extension (a declared `background` block is needed). */
	background?: { enabled: boolean; since: number }
}

export interface AuditLine {
	ts: string
	event: string
	id: string
	version?: string
	detail?: string
}

export const AUDIT_EVENTS = [
	'added',
	'verify-failed',
	'license-set',
	'license-failed',
	'license-expired',
	'notice-shown',
	'acknowledged',
	'declined',
	'enabled',
	'disabled',
	'started',
	'stopped',
	'exited',
	'restart',
	'failed',
	'grant',
	'revoke',
	'update-staged',
	'update-applied',
	'removed',
	'query-refused',
	'message-refused',
	'limit',
	'host-start',
	'host-stop',
	'maintenance',
	'record-narrowed',
	'key-set',
	'license-activated',
	'license-refreshed',
	'license-refresh-failed',
	'license-grace',
	'license-revoked',
	'license-released',
	'license-answer-refused',
	'background-on',
	'background-off',
	'handover',
	'indicator-missing',
	'ui-closed',
	'ui-file-changed',
	'lock-set',
	'lock-released',
	'unlock-failed',
] as const

const AUDIT_ROTATE_BYTES = 2 * 1024 * 1024
const AUDIT_KEEP = 5

export function atomicWrite(file: string, data: string | Uint8Array, mode = 0o600): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
	const fd = openSync(tmp, 'w', mode)
	try {
		writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	renameSync(tmp, file)
}

/**
 * Delete a folder the platform made read-only (versions are 0555, their files 0444). Files are made
 * writable too, since Windows refuses to delete a read-only file, and the delete is retried for a
 * moment because Windows also refuses while a program that just stopped still holds one of them.
 */
export function removeTree(path: string): void {
	const open = (p: string) => {
		try {
			chmodSync(p, 0o700)
		} catch {
			// not there or not ours
		}
		let names: string[] = []
		try {
			names = readdirSync(p)
		} catch {
			return
		}
		for (const n of names) {
			const c = join(p, n)
			try {
				if (statSync(c).isDirectory()) open(c)
				else chmodSync(c, 0o600)
			} catch {
				// vanished
			}
		}
	}
	if (!existsSync(path)) return
	open(path)
	rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

export class ExtensionStore {
	constructor(
		readonly home: string,
		private readonly now: () => number = Date.now,
	) {}

	get root(): string {
		return join(this.home, 'extensions')
	}
	dir(id: string): string {
		if (!/^[a-z0-9.-]+$/.test(id) || id.includes('..')) throw new Error(`bad extension id: ${id}`)
		return join(this.root, id)
	}
	versionDir(id: string, version: string): string {
		return join(this.dir(id), 'versions', version)
	}
	dataDir(id: string): string {
		return join(this.dir(id), 'data')
	}
	runDir(id: string): string {
		return join(this.dir(id), 'run')
	}
	file(id: string, name: string): string {
		return join(this.dir(id), name)
	}
	removedRecord(id: string): string {
		return join(this.root, '_removed', `${id}.consent.json`)
	}

	ensureRoot(): void {
		mkdirSync(this.root, { recursive: true, mode: 0o700 })
		try {
			chmodSync(this.root, 0o700)
		} catch {
			// not ours
		}
	}

	/** A random id for this install, salted into the person hash so a copied record never covers. */
	installId(): string {
		this.ensureRoot()
		const f = join(this.root, 'install-id')
		try {
			return readFileSync(f, 'utf8').trim()
		} catch {
			const id = randomUUID()
			atomicWrite(f, `${id}\n`, 0o600)
			return id
		}
	}

	listIds(): string[] {
		try {
			return readdirSync(this.root, { withFileTypes: true })
				.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
				.map((e) => e.name)
				.sort()
		} catch {
			return []
		}
	}

	readJson<T>(id: string, name: string): T | undefined {
		try {
			return JSON.parse(readFileSync(this.file(id, name), 'utf8')) as T
		} catch {
			return undefined
		}
	}
	writeJson(id: string, name: string, value: unknown, mode = 0o600): void {
		atomicWrite(this.file(id, name), `${JSON.stringify(value, null, 2)}\n`, mode)
	}

	readState(id: string): ExtensionState | undefined {
		return this.readJson<ExtensionState>(id, 'state.json')
	}
	writeState(state: ExtensionState): void {
		this.writeJson(state.id, 'state.json', state)
	}

	/** Every file of an unpacked version, from disk, for verification at each start. */
	readVersion(id: string, version: string): Map<string, PackageFile> {
		const base = this.versionDir(id, version)
		const out = new Map<string, PackageFile>()
		const walk = (dir: string, prefix: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const abs = join(dir, e.name)
				const rel = prefix ? `${prefix}/${e.name}` : e.name
				if (e.isSymbolicLink()) throw new Error(`a link inside an installed version: ${rel}`)
				if (e.isDirectory()) walk(abs, rel)
				else
					out.set(rel, { bytes: readFileSync(abs), executable: (statSync(abs).mode & 0o111) !== 0 })
			}
		}
		walk(base, '')
		return out
	}

	/** Unpack to a temp folder inside the extension's folder, then rename once the caller has verified. */
	unpack(id: string, version: string, files: Map<string, PackageFile>): string {
		const versions = join(this.dir(id), 'versions')
		mkdirSync(versions, { recursive: true, mode: 0o700 })
		const tmp = join(versions, `${version}.tmp-${randomBytes(4).toString('hex')}`)
		mkdirSync(tmp, { recursive: true, mode: 0o700 })
		const base = resolve(tmp)
		const dirs = new Set<string>([base])
		for (const [name, f] of files) {
			const abs = resolve(base, name)
			if (!abs.startsWith(base + sep)) throw new Error(`a path escapes the unpack folder: ${name}`)
			mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
			let d = dirname(abs)
			while (d.startsWith(base) && !dirs.has(d)) {
				dirs.add(d)
				d = dirname(d)
			}
			const fd = openSync(abs, 'wx', 0o600)
			try {
				writeSync(fd, f.bytes)
			} finally {
				closeSync(fd)
			}
			chmodSync(abs, f.executable ? 0o555 : 0o444)
		}
		for (const d of [...dirs].sort((a, b) => b.length - a.length)) chmodSync(d, 0o555)
		return tmp
	}
	commitUnpack(tmp: string, id: string, version: string): void {
		const dest = this.versionDir(id, version)
		if (existsSync(dest)) removeTree(dest)
		renameSync(tmp, dest)
	}
	/** A leftover `.tmp-*` from an interrupted add is deleted at the next host start. */
	sweepTemp(id: string): void {
		const versions = join(this.dir(id), 'versions')
		try {
			for (const n of readdirSync(versions)) if (n.includes('.tmp-')) removeTree(join(versions, n))
		} catch {
			// nothing to sweep
		}
	}

	audit(id: string, event: (typeof AUDIT_EVENTS)[number], version?: string, detail?: string): void {
		const line: AuditLine = {
			ts: new Date(this.now()).toISOString(),
			event,
			id,
			...(version ? { version } : {}),
			...(detail ? { detail: detail.slice(0, 300) } : {}),
		}
		const f = this.file(id, 'audit.log')
		try {
			mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
			try {
				if (statSync(f).size > AUDIT_ROTATE_BYTES) {
					for (let i = AUDIT_KEEP - 1; i >= 1; i--)
						if (existsSync(`${f}.${i}`)) renameSync(`${f}.${i}`, `${f}.${i + 1}`)
					renameSync(f, `${f}.1`)
				}
			} catch {
				// first line
			}
			appendFileSync(f, `${JSON.stringify(line)}\n`, { mode: 0o600 })
		} catch {
			// an audit line that cannot be written never stops the work it records
		}
	}
	readAudit(id: string, limit = 10): AuditLine[] {
		try {
			return readFileSync(this.file(id, 'audit.log'), 'utf8')
				.split('\n')
				.filter(Boolean)
				.slice(-limit)
				.map((l) => JSON.parse(l) as AuditLine)
		} catch {
			return []
		}
	}
}
