import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	StateFileBusyError,
	StateFileUnreadableError,
	copyTime,
	newestStateBackup,
	saveStateFile,
	startNewStateFile,
	unreadableStateFile,
	withStateFileLock,
} from './state-file.js'

const dirs: string[] = []
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-state-file-'))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

describe('state file lock', () => {
	it('holds <file>.lock during the change and lets go after', () => {
		const file = join(home(), 'trust.json')
		expect(withStateFileLock(file, () => existsSync(`${file}.lock`))).toBe(true)
		expect(existsSync(`${file}.lock`)).toBe(false)
	})

	it('is re-entrant, so a change made of several writes holds it once', () => {
		const file = join(home(), 'config.yaml')
		const result = withStateFileLock(file, () =>
			withStateFileLock(file, () => withStateFileLock(file, () => 'inner')),
		)
		expect(result).toBe('inner')
		expect(existsSync(`${file}.lock`)).toBe(false)
		// Released for real: another holder can take it now.
		expect(withStateFileLock(file, () => 'again')).toBe('again')
	})

	it('says in words that another process is saving, after waiting its turn', () => {
		const file = join(home(), 'trust.json')
		writeFileSync(`${file}.lock`, `${process.ppid}:0:live`)
		const waits: number[] = []
		let error: unknown
		try {
			withStateFileLock(file, () => 'never', { attempts: 4, wait: (n) => void waits.push(n) })
		} catch (caught) {
			error = caught
		}
		expect(error).toBeInstanceOf(StateFileBusyError)
		expect((error as Error).message).toContain('being saved by another Namzu process')
		expect((error as StateFileBusyError).sentence(() => '~/t')).toMatch(/^~\/t is being saved/)
		expect(waits).toEqual([0, 1, 2])
		expect(readFileSync(`${file}.lock`, 'utf8')).toBe(`${process.ppid}:0:live`)
	})

	it('passes an error from the change itself through unchanged', () => {
		const file = join(home(), 'trust.json')
		expect(() =>
			withStateFileLock(file, () => {
				throw new Error('the change failed')
			}),
		).toThrow('the change failed')
		expect(existsSync(`${file}.lock`)).toBe(false)
	})
})

describe('saving a state file', () => {
	it('keeps the old file in backups/ and writes the new one private', () => {
		const root = home()
		const file = join(root, 'trust.json')
		writeFileSync(file, 'old')
		saveStateFile(file, 'new', { home: root })
		expect(readFileSync(file, 'utf8')).toBe('new')
		const backup = newestStateBackup(root, file)
		expect(backup?.path).toMatch(/backups[/\\]trust\.json\.backup\.\d+$/)
		expect(readFileSync(backup?.path as string, 'utf8')).toBe('old')
		saveStateFile(file, 'newer', { home: root, backup: false })
		expect(readdirSync(join(root, 'backups'))).toHaveLength(1)
	})
})

describe('refusing an unreadable state file', () => {
	it('keeps its bytes, names the copy and the newest recovery copy, and changes nothing', () => {
		const root = home()
		const file = join(root, 'trust.json')
		writeFileSync(file, '{"trusted": ["/a"]}')
		saveStateFile(file, '{"trusted": ["/a", "/b"]}', { home: root })
		writeFileSync(file, '{"trusted": [')
		const error = unreadableStateFile(file, 'not valid JSON', root)
		expect(error).toBeInstanceOf(StateFileUnreadableError)
		expect(error.copy).toMatch(/trust\.json\.corrupted\.\d+$/)
		expect(readFileSync(error.copy as string, 'utf8')).toBe('{"trusted": [')
		const backup = newestStateBackup(root, file)
		expect(error.backup).toEqual(backup)
		// The copy is the file before the last change: it says so, and when.
		expect(readFileSync(backup?.path as string, 'utf8')).toBe('{"trusted": ["/a"]}')
		expect(error.message).toBe(
			`${file} could not be read (not valid JSON), so it was not changed. Its contents are kept in ${error.copy}. The newest recovery copy is ${backup?.path}, the file as it was before a change at ${copyTime(backup?.takenAt as number)}; that change and any later one are not in it. To go back to it, copy it over ${file}. Fix or remove the file, then try again.`,
		)
		expect(error.withRemedy('Start anew.').message.endsWith(' Start anew.')).toBe(true)
		expect(readFileSync(file, 'utf8')).toBe('{"trusted": [')
		// Asked again about the same damage: the same copy, not a second one.
		expect(unreadableStateFile(file, 'not valid JSON', root).copy).toBe(error.copy)
	})

	it('starts a new file only after the old bytes are kept and read back', () => {
		const root = home()
		const file = join(root, 'trust.json')
		writeFileSync(file, '{ damaged')
		const kept = startNewStateFile(file, '{"version":1,"trusted":[]}\n', root)
		expect(kept).toMatch(/backups[/\\]trust\.json\.corrupted\.\d+$/)
		expect(readFileSync(kept, 'utf8')).toBe('{ damaged')
		expect(readFileSync(file, 'utf8')).toBe('{"version":1,"trusted":[]}\n')
		// The damaged bytes are not offered as a recovery copy of the good list.
		expect(newestStateBackup(root, file)).toBeUndefined()
	})

	it('replaces nothing when the old bytes cannot be kept', () => {
		const root = home()
		const file = join(root, 'trust.json')
		writeFileSync(file, '{ damaged')
		// A file where the backups folder goes: no copy can be made.
		writeFileSync(join(root, 'backups'), 'not a folder')
		expect(() => startNewStateFile(file, '{}', root)).toThrow()
		expect(readFileSync(file, 'utf8')).toBe('{ damaged')
	})

	it('still refuses when even the copy cannot be made', () => {
		const root = home()
		const file = join(root, 'trust.json')
		mkdirSync(file)
		const error = unreadableStateFile(file, 'it is a folder', root)
		expect(error.copy).toBeUndefined()
		expect(error.message).toBe(
			`${file} could not be read (it is a folder), so it was not changed. Fix or remove the file, then try again.`,
		)
	})
})
