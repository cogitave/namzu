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

	it('takes nothing for a file that does not exist yet', () => {
		const root = home()
		expect(backupStateFile(join(root, 'config.yaml'), { home: root })).toBeUndefined()
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

	it('takes a copy when the newest one is stamped in the future (a clock moved back)', () => {
		const root = home()
		const file = join(root, 'config.yaml')
		writeFileSync(file, 'a: 1\n')
		backupStateFile(file, { home: root, now: () => 10 * STATE_BACKUP_MIN_INTERVAL_MS })
		writeFileSync(file, 'a: 2\n')
		expect(backupStateFile(file, { home: root, now: () => 1 })).toBeDefined()
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
		expect(listStateFileCopies(root)).toEqual([])
	})
})

describe('unreadable state files', () => {
	it('keeps the bytes as backups/<file>.corrupt-<ms>, once per distinct content', () => {
		const root = home()
		const file = join(root, 'trust.json')
		writeFileSync(file, '{"trusted": [')
		const first = preserveUnreadableStateFile(file, { home: root, now: () => 42 })
		expect(first).toEqual({
			path: join(stateBackupsDir(root), 'trust.json.corrupt-42'),
			fresh: true,
		})
		expect(readFileSync(first.path, 'utf8')).toBe('{"trusted": [')
		if (posix) expect(statSync(first.path).mode & 0o777).toBe(0o600)
		const again = preserveUnreadableStateFile(file, { home: root, now: () => 99 })
		expect(again).toEqual({ path: first.path, fresh: false })
		writeFileSync(file, 'other damage')
		expect(preserveUnreadableStateFile(file, { home: root, now: () => 42 }).path).toBe(
			join(stateBackupsDir(root), 'trust.json.corrupt-43'),
		)
		expect(listStateFileCopies(root, 'trust.json').every((c) => c.kind === 'corrupt')).toBe(true)
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
		writeFileSync(join(dir, 'accounts.json.corrupt-3'), 'drop me')
		writeFileSync(join(dir, 'trust.json.backup.4'), 'secret elsewhere')
		rewriteStateFileBackups(root, 'accounts.json', (text) =>
			text === 'drop me' ? undefined : text.replace('secret', ''),
		)
		expect(readFileSync(join(dir, 'accounts.json.backup.1'), 'utf8')).toBe(' here')
		expect(readFileSync(join(dir, 'accounts.json.backup.2'), 'utf8')).toBe('nothing')
		expect(existsSync(join(dir, 'accounts.json.corrupt-3'))).toBe(false)
		expect(readFileSync(join(dir, 'trust.json.backup.4'), 'utf8')).toBe('secret elsewhere')
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
