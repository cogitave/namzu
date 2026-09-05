import { randomUUID } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { restrictToOwner } from '../providers/credential-store.js'

/**
 * Publish a complete private JSON record only if its canonical name is absent.
 * Concurrent creators must read that name afterwards to obtain the winner.
 *
 * Exclusive creation of the canonical file would expose an empty/partial JSON
 * record to readers. Rename would overwrite another creator's identity. A
 * same-directory hard link provides both complete publication and one winner.
 */
export function publishPrivateJsonIfAbsent(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const candidate = `${path}.candidate.${randomUUID()}`
	const descriptor = openSync(candidate, 'wx', 0o600)
	try {
		try {
			writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
			fsyncSync(descriptor)
		} finally {
			closeSync(descriptor)
		}
		restrictToOwner(candidate)
		try {
			linkSync(candidate, path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
	} finally {
		unlinkSync(candidate)
	}
}
