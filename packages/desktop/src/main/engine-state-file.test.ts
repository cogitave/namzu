import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupEngineStateFile, withEngineStateLock } from './engine-state-file.js'

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
})
