import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
	STATE_BACKUP_KEEP,
	STATE_BACKUP_MIN_INTERVAL_MS,
	backupStateFile,
	listStateFileCopies,
	preserveUnreadableStateFile,
	rewriteStateFileBackups,
	stateBackupsDir,
	writeFileAtomicSync,
} from '../state-backup.js'

const dirs: string[] = []
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-state-backup-'))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const posix = process.platform !== 'win32'

describe('state file backups', () => {
	it('copies the file before a write as backups/<file>.backup.<ms>, private', () => {
		const root = home()
		const file = join(root, 'trust.json')
		writeFileSync(file, '{"trusted":["/a"]}\n', { mode: 0o644 })
		if (posix) chmodSync(file, 0o644)
		const copy = backupStateFile(file, { home: root, now: () => 1_000_000 })
		expect(copy).toBe(join(stateBackupsDir(root), 'trust.json.backup.1000000'))
		expect(readFileSync(copy as string, 'utf8')).toBe('{"trusted":["/a"]}\n')
		if (posix) {
			expect(statSync(copy as string).mode & 0o777).toBe(0o600)
			expect(statSync(stateBackupsDir(root)).mode & 0o777).toBe(0o700)
		}
	})

	it('takes nothing for a file that does not exist yet, or is empty', () => {
		const root = home()
		expect(backupStateFile(join(root, 'config.yaml'), { home: root })).toBeUndefined()
		writeFileSync(join(root, 'trust.json'), ' \n')
		expect(backupStateFile(join(root, 'trust.json'), { home: root })).toBeUndefined()
		expect(existsSync(stateBackupsDir(root))).toBe(false)
	})

	it('takes at most one copy a minute per file', () => {
		const root = home()
		const file = join(root, 'config.yaml')
		let now = 5_000_000
		writeFileSync(file, 'a: 1\n')
		expect(backupStateFile(file, { home: root, now: () => now })).toBeDefined()
		writeFileSync(file, 'a: 2\n')
		now += STATE_BACKUP_MIN_INTERVAL_MS - 1
		expect(backupStateFile(file, { home: root, now: () => now })).toBeUndefined()
		// Another file has its own minute.
		const other = join(root, 'trust.json')
		writeFileSync(other, '{}')
		expect(backupStateFile(other, { home: root, now: () => now })).toBeDefined()
		now += 1
		expect(backupStateFile(file, { home: root, now: () => now })).toBeDefined()
		expect(listStateFileCopies(root, 'config.yaml').map((c) => c.at)).toEqual([
			5_000_000 + STATE_BACKUP_MIN_INTERVAL_MS,
			5_000_000,
		])
	})

	it('keeps the newest five copies of a file', () => {
		const root = home()
		const file = join(root, 'mcp-approvals.json')
		for (let i = 0; i < STATE_BACKUP_KEEP + 3; i++) {
			writeFileSync(file, `{"n":${i}}`)
			backupStateFile(file, { home: root, now: () => i * STATE_BACKUP_MIN_INTERVAL_MS })
		}
		const kept = listStateFileCopies(root, 'mcp-approvals.json')
		expect(kept).toHaveLength(STATE_BACKUP_KEEP)
		expect(kept.map((c) => readFileSync(c.path, 'utf8'))).toEqual([
			'{"n":7}',
			'{"n":6}',
			'{"n":5}',
			'{"n":4}',
			'{"n":3}',
		])
	})

	it('does not spend a slot on a copy identical to the newest one', () => {
		const root = home()
		const file = join(root, 'preferences.json')
		writeFileSync(file, 'same')
		expect(backupStateFile(file, { home: root, now: () => 0 })).toBeDefined()
		expect(
			backupStateFile(file, { home: root, now: () => STATE_BACKUP_MIN_INTERVAL_MS * 2 }),
		).toBeUndefined()
		expect(listStateFileCopies(root, 'preferences.json')).toHaveLength(1)
	})

	it('takes a copy when the newest one was taken "later" than now (a clock moved back)', () => {
		const root = home()
		const file = join(root, 'config.yaml')
		writeFileSync(file, 'a: 1\n')
		backupStateFile(file, { home: root, now: () => 10 * STATE_BACKUP_MIN_INTERVAL_MS })
		writeFileSync(file, 'a: 2\n')
		// Numbered past the newest, so it still sorts as the copy written last.
		expect(backupStateFile(file, { home: root, now: () => 1 })).toBe(
			join(stateBackupsDir(root), `config.yaml.backup.${10 * STATE_BACKUP_MIN_INTERVAL_MS + 1}`),
		)
	})

	it('after the clock went back, names the latest copy newest and keeps one a minute', () => {
		const root = home()
		const file = join(root, 'trust.json')
		const ahead = 10_000_000_000_000
		writeFileSync(file, 'S0')
		backupStateFile(file, { home: root, now: () => ahead })
		const corrected = 1_700_000_000_000
		for (const [i, state] of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].entries()) {
			writeFileSync(file, state)
			backupStateFile(file, { home: root, now: () => corrected + i * 1000 })
		}
		// One copy after the correction (S1); the five a second apart after it are within its minute.
		let copies = listStateFileCopies(root, 'trust.json')
		expect(copies.map((c) => readFileSync(c.path, 'utf8'))).toEqual(['S1', 'S0'])
		expect(copies[0]?.takenAt).toBe(corrected)
		writeFileSync(file, 'S7')
		backupStateFile(file, { home: root, now: () => corrected + STATE_BACKUP_MIN_INTERVAL_MS })
		copies = listStateFileCopies(root, 'trust.json')
		expect(readFileSync(copies[0]?.path as string, 'utf8')).toBe('S7')
		// Pruning drops the oldest written, not the one with the largest clock reading.
		for (let i = 2; i < 8; i++) {
			writeFileSync(file, `T${i}`)
			backupStateFile(file, { home: root, now: () => corrected + i * STATE_BACKUP_MIN_INTERVAL_MS })
		}
		copies = listStateFileCopies(root, 'trust.json')
		expect(copies.map((c) => readFileSync(c.path, 'utf8'))).toEqual(['T7', 'T6', 'T5', 'T4', 'T3'])
	})

	it('copies the text a redaction leaves, never the secret', () => {
		const root = home()
		const file = join(root, 'accounts.json')
		writeFileSync(file, '{"keys":{"a":"sk-secret"}}')
		const copy = backupStateFile(file, {
			home: root,
			now: () => 7,
			redact: (text) => text.replace('sk-secret', ''),
		})
		expect(readFileSync(copy as string, 'utf8')).toBe('{"keys":{"a":""}}')
	})

	it('never throws when the copy cannot be written', () => {
		const root = home()
		const file = join(root, 'config.yaml')
		writeFileSync(file, 'a: 1\n')
		// A file where the folder should be: the copy fails, the caller's write goes on.
		writeFileSync(stateBackupsDir(root), 'not a folder')
		expect(backupStateFile(file, { home: root })).toBeUndefined()
	})

	it('ignores names that are not copies', () => {
		const root = home()
		mkdirSync(stateBackupsDir(root))
		writeFileSync(join(stateBackupsDir(root), 'notes.txt'), '')
		writeFileSync(join(stateBackupsDir(root), 'trust.json.backup.12.1.2.ab.tmp'), '')
		writeFileSync(join(stateBackupsDir(root), 'trust.json.corrupt-12'), '')
		expect(listStateFileCopies(root)).toEqual([])
	})
})

describe('unreadable state files', () => {
	it('keeps the bytes as backups/<file>.corrupted.<ms>, once per distinct content', () => {
		const root = home()
		const file = join(root, 'trust.json')
		writeFileSync(file, '{"trusted": [')
		const first = preserveUnreadableStateFile(file, { home: root, now: () => 42 })
		expect(first).toEqual({
			path: join(stateBackupsDir(root), 'trust.json.corrupted.42'),
			fresh: true,
		})
		expect(readFileSync(first.path, 'utf8')).toBe('{"trusted": [')
		if (posix) expect(statSync(first.path).mode & 0o777).toBe(0o600)
		const again = preserveUnreadableStateFile(file, { home: root, now: () => 99 })
		expect(again).toEqual({ path: first.path, fresh: false })
		writeFileSync(file, 'other damage')
		expect(preserveUnreadableStateFile(file, { home: root, now: () => 42 }).path).toBe(
			join(stateBackupsDir(root), 'trust.json.corrupted.43'),
		)
		expect(listStateFileCopies(root, 'trust.json').every((c) => c.kind === 'corrupted')).toBe(true)
	})

	it('throws when there is nothing it can copy, so the caller refuses its write', () => {
		const root = home()
		expect(() => preserveUnreadableStateFile(join(root, 'gone.json'), { home: root })).toThrow()
	})
})

describe('rewriting recovery copies', () => {
	it('changes, keeps or removes each copy as the edit says', () => {
		const root = home()
		const dir = stateBackupsDir(root)
		mkdirSync(dir)
		writeFileSync(join(dir, 'accounts.json.backup.1'), 'secret here')
		writeFileSync(join(dir, 'accounts.json.backup.2'), 'nothing')
		writeFileSync(join(dir, 'accounts.json.corrupted.3'), 'drop me')
		writeFileSync(join(dir, 'trust.json.backup.4'), 'secret elsewhere')
		rewriteStateFileBackups(root, 'accounts.json', (text) =>
			text === 'drop me' ? undefined : text.replace('secret', ''),
		)
		expect(readFileSync(join(dir, 'accounts.json.backup.1'), 'utf8')).toBe(' here')
		expect(readFileSync(join(dir, 'accounts.json.backup.2'), 'utf8')).toBe('nothing')
		expect(existsSync(join(dir, 'accounts.json.corrupted.3'))).toBe(false)
		expect(readFileSync(join(dir, 'trust.json.backup.4'), 'utf8')).toBe('secret elsewhere')
	})

	it('keeps the time a rewritten copy was taken, so the one-a-minute limit is unchanged', () => {
		const root = home()
		const file = join(root, 'accounts.json')
		writeFileSync(file, 'secret one')
		backupStateFile(file, { home: root, now: () => 3_000_000 })
		rewriteStateFileBackups(root, 'accounts.json', (text) => text.replace('secret', ''))
		const [copy] = listStateFileCopies(root, 'accounts.json')
		expect(readFileSync(copy?.path as string, 'utf8')).toBe(' one')
		expect(copy?.takenAt).toBe(3_000_000)
	})

	it('removes a copy the edit fails on rather than leaving it as it was', () => {
		const root = home()
		const dir = stateBackupsDir(root)
		mkdirSync(dir)
		writeFileSync(join(dir, 'accounts.json.backup.1'), 'x')
		rewriteStateFileBackups(root, 'accounts.json', () => {
			throw new Error('cannot')
		})
		expect(readdirSync(dir)).toEqual([])
	})
})

describe('atomic sync write', () => {
	it('replaces the file whole, private, with no temporary left behind', () => {
		const root = home()
		const file = join(root, 'state.json')
		writeFileSync(file, 'old')
		writeFileAtomicSync(file, 'new')
		expect(readFileSync(file, 'utf8')).toBe('new')
		writeFileAtomicSync(file, Buffer.from('bytes'))
		expect(readFileSync(file, 'utf8')).toBe('bytes')
		if (posix) expect(statSync(file).mode & 0o777).toBe(0o600)
		expect(readdirSync(root)).toEqual(['state.json'])
	})

	it('leaves the old file and no temporary when the write fails', () => {
		const root = home()
		const file = join(root, 'state.json')
		mkdirSync(file)
		expect(() => writeFileAtomicSync(file, 'new')).toThrow()
		expect(readdirSync(root)).toEqual(['state.json'])
	})
})
