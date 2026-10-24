import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { namzuHomePath } from '../integrations/state/home.js'
import type { QueuedHintCount } from './composer-hints.js'

/**
 * How many times each one-time hint has appeared, kept in
 * `~/.namzu/hint-counts.json` beside the other per-person records so the count
 * survives launches. An unreadable file reads as zero, so a damaged record
 * costs a hint one more showing and never hides one early; a write that fails
 * is dropped, because a hint is not worth interrupting the composer for.
 */

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export function hintCountsPath(home?: string): string {
	return join(namzuHomePath(home), 'hint-counts.json')
}

function readAll(path: string): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
		if (typeof parsed !== 'object' || parsed === null) return {}
		const counts: Record<string, number> = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'number' && Number.isInteger(value) && value >= 0) counts[key] = value
		}
		return counts
	} catch {
		return {}
	}
}

export function readHintCount(name: string, home?: string): number {
	return readAll(hintCountsPath(home))[name] ?? 0
}

export function writeHintCount(name: string, count: number, home?: string): void {
	const path = hintCountsPath(home)
	const temp = `${path}.${randomUUID()}.tmp`
	try {
		mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
		writeFileSync(temp, `${JSON.stringify({ ...readAll(path), [name]: count }, null, 2)}\n`, {
			mode: FILE_MODE,
		})
		renameSync(temp, path)
	} catch {
		rmSync(temp, { force: true })
	}
}

/** The queued-messages hint's count, stored under the reference's own key name. */
export function fileQueuedHintCount(home?: string): QueuedHintCount {
	return {
		read: () => readHintCount('queuedCommandUpHintCount', home),
		write: (count) => writeHintCount('queuedCommandUpHintCount', count, home),
	}
}
