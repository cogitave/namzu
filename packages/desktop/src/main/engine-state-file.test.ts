import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLockSync } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
	backupEngineStateFile,
	preserveUnreadableEngineStateFile,
	withEngineStateLock,
} from './engine-state-file.js'

const dirs: string[] = []
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-engine-state-'))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Desktop's copy of the engine's state file rules", () => {
	it('names copies as the engine does, one a minute, five kept, none equal to the newest', () => {
		const home = scratch()
		const file = join(home, 'trust.json')
		let now = 1_000_000
		for (let i = 0; i < 8; i++) {
			writeFileSync(file, `{"n":${i}}`)
			expect(backupEngineStateFile(file, home, () => now)).toBe(
				join(home, 'backups', `trust.json.backup.${now}`),
			)
			// Within the minute: no second copy.
			expect(backupEngineStateFile(file, home, () => now + 59_999)).toBeUndefined()
			now += 60_000
		}
		const kept = readdirSync(join(home, 'backups')).sort()
		expect(kept).toHaveLength(5)
		expect(readFileSync(join(home, 'backups', kept[0] as string), 'utf8')).toBe('{"n":3}')
		// The same bytes as the newest copy: not taken again.
		expect(backupEngineStateFile(file, home, () => now)).toBeUndefined()
	})

	it('takes no copy of a file that is not there, and never throws', () => {
		const home = scratch()
		expect(backupEngineStateFile(join(home, 'trust.json'), home)).toBeUndefined()
		writeFileSync(join(home, 'trust.json'), '{}')
		writeFileSync(join(home, 'backups'), 'a file where the folder goes')
		expect(backupEngineStateFile(join(home, 'trust.json'), home)).toBeUndefined()
	})

	it('removes its lock after the work, also when the work throws', () => {
		const home = scratch()
		const file = join(home, 'trust.json')
		expect(() =>
			withEngineStateLock(file, () => {
				throw new Error('boom')
			}),
		).toThrow('boom')
		expect(readdirSync(home)).toEqual([])
	})

	it('after the clock went back, numbers the next copy past the newest and keeps one a minute', () => {
		const home = scratch()
		const file = join(home, 'trust.json')
		const ahead = 10_000_000_000_000
		writeFileSync(file, 'S0')
		backupEngineStateFile(file, home, () => ahead)
		const corrected = 1_700_000_000_000
		writeFileSync(file, 'S1')
		expect(backupEngineStateFile(file, home, () => corrected)).toBe(
			join(home, 'backups', `trust.json.backup.${ahead + 1}`),
		)
		writeFileSync(file, 'S2')
		expect(backupEngineStateFile(file, home, () => corrected + 1000)).toBeUndefined()
	})

	it('takes no copy of an empty file', () => {
		const home = scratch()
		writeFileSync(join(home, 'trust.json'), '')
		expect(backupEngineStateFile(join(home, 'trust.json'), home)).toBeUndefined()
	})

	it('keeps an unreadable file once per content, private, under the engine name', () => {
		const home = scratch()
		const file = join(home, 'trust.json')
		writeFileSync(file, '{ damaged')
		const kept = preserveUnreadableEngineStateFile(file, home, () => 42)
		expect(kept).toBe(join(home, 'backups', 'trust.json.corrupted.42'))
		expect(preserveUnreadableEngineStateFile(file, home, () => 99)).toBe(kept)
		expect(readFileSync(kept, 'utf8')).toBe('{ damaged')
	})

	it('takes over a lock that never got its body, once it is older than ten seconds', () => {
		const home = scratch()
		const file = join(home, 'trust.json')
		writeFileSync(`${file}.lock`, '')
		expect(() => withEngineStateLock(file, () => 'never', { attempts: 1 })).toThrow(
			'saving this list in another window',
		)
		const old = (Date.now() - 60_000) / 1000
		utimesSync(`${file}.lock`, old, old)
		expect(withEngineStateLock(file, () => 'ran')).toBe('ran')
		expect(existsSync(`${file}.lock`)).toBe(false)
	})

	it('takes over a lock with its own pid that it does not hold, but never one the engine holds here', () => {
		const home = scratch()
		const file = join(home, 'trust.json')
		writeFileSync(`${file}.lock`, `${process.pid}:0:left-over`)
		expect(withEngineStateLock(file, () => 'ran')).toBe('ran')
		// The engine's own lock taken in this process: Desktop's copy knows it is held.
		expect(() =>
			withFileLockSync(`${file}.lock`, () =>
				withEngineStateLock(file, () => 'never', { attempts: 1 }),
			),
		).toThrow('saving this list in another window')
	})
})
