import { createHash, randomUUID } from 'node:crypto'
import {
	constants,
	closeSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { restrictToOwner } from '../providers/credential-store.js'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'

interface PluginLocation {
	readonly rootDir: string
	readonly name: string
}

const MAX_RECORD_BYTES = 64 * 1024

/** One atomic setting per admitted physical plugin, independent of other projects. */
export class PluginSettingsStore {
	readonly directory: string

	constructor(private readonly home: string) {
		this.directory = join(home, 'plugin-settings')
	}

	private path(plugin: PluginLocation): string {
		// The lifecycle manager supplies a canonical root. Names alone would make
		// disabling a project plugin disable unrelated plugins in other projects.
		const key = createHash('sha256')
			.update(JSON.stringify([plugin.rootDir, plugin.name]))
			.digest('hex')
		return join(this.directory, `${key}.json`)
	}

	read(plugin: PluginLocation): boolean {
		const path = this.path(plugin)
		try {
			try {
				const directory = lstatSync(this.directory)
				if (!directory.isDirectory() || directory.isSymbolicLink()) {
					throw new Error('settings directory must be a real directory')
				}
				const entry = lstatSync(path)
				if (!entry.isFile() || entry.isSymbolicLink()) {
					throw new Error('setting must be a regular file')
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
				throw error
			}
			const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
			let raw: string
			try {
				if (!fstatSync(fd).isFile()) throw new Error('setting must be a regular file')
				const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
				let size = 0
				while (size < buffer.length) {
					const bytes = readSync(fd, buffer, size, buffer.length - size, null)
					if (bytes === 0) break
					size += bytes
				}
				if (size > MAX_RECORD_BYTES) throw new Error('setting exceeds 64 KiB')
				raw = buffer.toString('utf8', 0, size)
			} finally {
				closeSync(fd)
			}
			const value = JSON.parse(raw) as Record<string, unknown> | null
			if (
				!value ||
				value.version !== 1 ||
				value.rootDir !== plugin.rootDir ||
				value.name !== plugin.name ||
				typeof value.enabled !== 'boolean'
			) {
				throw new Error('setting has an invalid version, plugin identity or enabled value')
			}
			return value.enabled
		} catch (error) {
			// Corruption must not quietly turn a disabled executable plugin on.
			throw new Error(`Could not read plugin setting ${path}: ${String(error)}`, { cause: error })
		}
	}

	write(plugin: PluginLocation, enabled: boolean): void {
		ensurePrivateStateDirectory(this.home, 'plugin-settings')
		this.read(plugin)
		const path = this.path(plugin)
		const temporary = `${path}.tmp.${randomUUID()}`
		const fd = openSync(temporary, 'wx', 0o600)
		try {
			try {
				writeFileSync(
					fd,
					`${JSON.stringify({ version: 1, rootDir: plugin.rootDir, name: plugin.name, enabled }, null, 2)}\n`,
				)
				fsyncSync(fd)
			} finally {
				closeSync(fd)
			}
			restrictToOwner(temporary)
			// Separate plugins never overwrite each other's settings. For this
			// plugin the last complete replacement wins, without a stale RMW merge.
			renameSync(temporary, path)
		} finally {
			try {
				unlinkSync(temporary)
			} catch {
				// Cleanup must not mask a write error or turn a committed rename
				// into a reported failure. Temporary names are never read as settings.
			}
		}
	}
}
