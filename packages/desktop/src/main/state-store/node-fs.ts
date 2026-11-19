import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { StateFs } from './store.js'

/** The real disk. A missing file reads as `undefined`; any other failure is the caller's to see. */
export const nodeStateFs: StateFs = {
	read(file) {
		try {
			return readFileSync(file, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
			throw error
		}
	},
	write: (file, text) => writeFileSync(file, text, { mode: 0o600 }),
	rename: (from, to) => renameSync(from, to),
	mkdirp: (dir) => {
		mkdirSync(dir, { recursive: true })
	},
}
