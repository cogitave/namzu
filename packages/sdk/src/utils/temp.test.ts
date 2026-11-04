import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const failing = vi.hoisted(() => ({ code: undefined as string | undefined }))

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		mkdirSync: ((...args: Parameters<typeof actual.mkdirSync>) => {
			if (failing.code !== undefined) {
				throw Object.assign(new Error(failing.code), { code: failing.code })
			}
			return actual.mkdirSync(...args)
		}) as typeof actual.mkdirSync,
	}
})

import {
	NAMZU_TMPDIR_ENV,
	TempDirectoryError,
	createTempDirSync,
	privateTempRoot,
	resolveTempBase,
	tempFilePath,
} from './temp.js'

let base: string
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), 'namzu-temp-test-'))
	failing.code = undefined
})
afterEach(() => {
	failing.code = undefined
	rmSync(base, { recursive: true, force: true })
})

describe('the temporary base', () => {
	it('is the operating system folder unless NAMZU_TMPDIR names another', () => {
		expect(resolveTempBase({})).toBe(tmpdir())
		expect(resolveTempBase({ [NAMZU_TMPDIR_ENV]: '' })).toBe(tmpdir())
		expect(resolveTempBase({ [NAMZU_TMPDIR_ENV]: base })).toBe(base)
	})

	it('refuses a relative NAMZU_TMPDIR in words that name the variable', () => {
		expect(() => resolveTempBase({ [NAMZU_TMPDIR_ENV]: 'scratch' })).toThrow(
			/NAMZU_TMPDIR must be a full path/,
		)
	})

	it('puts the private root under NAMZU_TMPDIR', () => {
		const root = privateTempRoot({ env: { [NAMZU_TMPDIR_ENV]: base } })
		expect(root.startsWith(base)).toBe(true)
	})
})

describe('the private root', () => {
	it('is created with mode 700', () => {
		const root = privateTempRoot({ tmpdir: base })
		expect(statSync(root).mode & 0o777).toBe(0o700)
		expect(privateTempRoot({ tmpdir: base })).toBe(root)
	})

	it('refuses a symbolic link', () => {
		const uid = process.getuid?.() ?? 0
		const target = join(base, 'elsewhere')
		mkdirSync(target)
		symlinkSync(target, join(base, `namzu-${uid}`))
		expect(() => privateTempRoot({ tmpdir: base })).toThrow(/symbolic link/)
		expect(lstatSync(join(base, `namzu-${uid}`)).isSymbolicLink()).toBe(true)
	})

	it('refuses a folder that belongs to another user, naming the variable', () => {
		const uid = process.getuid?.() ?? 0
		mkdirSync(join(base, `namzu-${uid + 1}`), { mode: 0o700 })
		expect(() => privateTempRoot({ tmpdir: base, getuid: () => uid + 1 })).toThrow(
			/belongs to uid.*NAMZU_TMPDIR/,
		)
	})

	it('refuses a folder open to others', () => {
		const uid = process.getuid?.() ?? 0
		mkdirSync(join(base, `namzu-${uid}`), { mode: 0o755 })
		chmodOpen(join(base, `namzu-${uid}`))
		expect(() => privateTempRoot({ tmpdir: base, getuid: () => uid })).toThrow(/must be 700/)
	})
})

function chmodOpen(path: string): void {
	// mkdir is subject to the umask; make the mode what the test says.
	chmodSync(path, 0o755)
}

describe('a folder that cannot be created', () => {
	it.each([
		[
			'ENOSPC',
			/^The disk is full, so Namzu could not create .*namzu-.*\. Free some space and start again, or set NAMZU_TMPDIR to a folder on another disk\.$/,
		],
		['EDQUOT', /^Your disk quota is used up, so Namzu could not create /],
		['EACCES', /cannot be written to\. Set NAMZU_TMPDIR to a folder you can write to\.$/],
		['ENOENT', /parent folder does not exist/],
	])('says %s in plain words and names the folder and the variable', (code, text) => {
		failing.code = code
		let caught: unknown
		try {
			privateTempRoot({ tmpdir: base })
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(TempDirectoryError)
		const message = (caught as TempDirectoryError).message
		expect(message).toMatch(text)
		expect(message).toContain(base)
		expect(message).not.toMatch(/\n|ENOSPC|EDQUOT|EACCES|ENOENT|\bat \S+:\d+/)
	})

	it('does not fall back to another folder', () => {
		failing.code = 'ENOSPC'
		expect(() => tempFilePath('x', { tmpdir: base })).toThrow(TempDirectoryError)
		expect(() => createTempDirSync('x-', { tmpdir: base })).toThrow(TempDirectoryError)
	})
})

describe('a scratch folder and file', () => {
	it('are inside the private root', () => {
		const dir = createTempDirSync('probe-', { tmpdir: base })
		const root = privateTempRoot({ tmpdir: base })
		expect(dir.startsWith(join(root, 'probe-'))).toBe(true)
		expect(tempFilePath('a.png', { tmpdir: base })).toBe(join(root, 'a.png'))
	})
})
