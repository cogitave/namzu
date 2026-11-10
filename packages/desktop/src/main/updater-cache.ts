import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** The numeric parts of the first `1.2.3` in a file name, or undefined when there is none. */
export function versionInName(name: string): number[] | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(name)
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** True when `version` is the same as or older than `current`. */
export function notNewerThan(version: number[], current: number[]): boolean {
	for (let index = 0; index < 3; index += 1) {
		const a = version[index] ?? 0
		const b = current[index] ?? 0
		if (a !== b) return a < b
	}
	return true
}

/**
 * electron-updater keeps the installer it downloaded in `<cache>/pending` and never clears it
 * once that version is installed, so every update leaves a full installer (about 500 MB) behind.
 * This removes the files of a pending download that is not newer than the running version.
 * `<cache>/installer.exe`, the copy the next differential download is built from, is not touched,
 * and a pending installer that IS newer (downloaded, not installed yet) is kept.
 * Returns the number of entries removed. Never throws: a file the updater holds open stays.
 */
export function clearInstalledPending(cacheDir: string, currentVersion: string): number {
	const current = versionInName(currentVersion)
	const pending = join(cacheDir, 'pending')
	if (!current || !existsSync(pending)) return 0
	let removed = 0
	try {
		let named: string | undefined
		try {
			const info = JSON.parse(readFileSync(join(pending, 'update-info.json'), 'utf8')) as {
				fileName?: unknown
			}
			if (typeof info.fileName === 'string') named = info.fileName
		} catch {
			// No descriptor: each installer is judged by its own name below.
		}
		const entries = readdirSync(pending)
		const stale = entries.filter((entry) => {
			if (entry === 'update-info.json') return false
			const version = versionInName(entry)
			return version !== undefined && notNewerThan(version, current)
		})
		for (const entry of stale) {
			rmSync(join(pending, entry), { recursive: true, force: true })
			removed += 1
		}
		// The descriptor goes with the installer it names, and only then.
		if (named && stale.includes(named)) rmSync(join(pending, 'update-info.json'), { force: true })
	} catch {
		// Quiet by design; the next check tries again.
	}
	return removed
}
