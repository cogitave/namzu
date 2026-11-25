import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { UnsafeWritePathError, atomicWriteFile } from '../atomic-write-file.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs.splice(0))
})

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-atomic-file-'))
	dirs.push(dir)
	return dir
}

const linkable = process.platform !== 'win32'

describe('atomicWriteFile', () => {
	it('writes the whole body, makes the folders and leaves no temporary behind', async () => {
		const root = tempDir()
		const file = join(root, 'a', 'b', 'file.md')
		await atomicWriteFile(file, 'hello')
		expect(readFileSync(file, 'utf8')).toBe('hello')
		expect(readdirSync(join(root, 'a', 'b'))).toEqual(['file.md'])
	})

	it.skipIf(!linkable)('gives a new file the mode it was asked for', async () => {
		const file = join(tempDir(), 'file.md')
		await atomicWriteFile(file, 'x', { mode: 0o600 })
		expect(statSync(file).mode & 0o777).toBe(0o600)
	})

	it.skipIf(!linkable)(
		'by default writes through a link and keeps it, as the file tools do',
		async () => {
			const root = tempDir()
			const real = join(root, 'real.txt')
			const link = join(root, 'link.txt')
			writeFileSync(real, 'old')
			symlinkSync(real, link)
			await atomicWriteFile(link, 'new')
			expect(lstatSync(link).isSymbolicLink()).toBe(true)
			expect(readFileSync(real, 'utf8')).toBe('new')
		},
	)

	describe('refuseLinksBelow', () => {
		it('writes a plain path below the folder', async () => {
			const root = tempDir()
			const file = join(root, 'skills', 'x', 'SKILL.md')
			await atomicWriteFile(file, 'ok', { refuseLinksBelow: root })
			expect(readFileSync(file, 'utf8')).toBe('ok')
		})

		it('refuses a path that is not inside the folder', async () => {
			const root = tempDir()
			const other = tempDir()
			await expect(
				atomicWriteFile(join(other, 'f.md'), 'x', { refuseLinksBelow: root }),
			).rejects.toBeInstanceOf(UnsafeWritePathError)
			expect(readdirSync(other)).toEqual([])
		})

		it.skipIf(!linkable)(
			'refuses a linked folder and the file itself, writing nothing',
			async () => {
				const root = tempDir()
				const elsewhere = tempDir()
				symlinkSync(elsewhere, join(root, 'linked'))
				await expect(
					atomicWriteFile(join(root, 'linked', 'f.md'), 'x', { refuseLinksBelow: root }),
				).rejects.toThrow(/symbolic link/)
				expect(readdirSync(elsewhere)).toEqual([])

				mkdirSync(join(root, 'dir'))
				writeFileSync(join(elsewhere, 'target.md'), 'keep')
				symlinkSync(join(elsewhere, 'target.md'), join(root, 'dir', 'f.md'))
				await expect(
					atomicWriteFile(join(root, 'dir', 'f.md'), 'x', { refuseLinksBelow: root }),
				).rejects.toBeInstanceOf(UnsafeWritePathError)
				expect(readFileSync(join(elsewhere, 'target.md'), 'utf8')).toBe('keep')
			},
		)

		it.skipIf(!linkable)('refuses a link swapped in after the body is written', async () => {
			const root = tempDir()
			const elsewhere = tempDir()
			mkdirSync(join(root, 'dir'))
			await expect(
				atomicWriteFile(join(root, 'dir', 'f.md'), 'x', {
					refuseLinksBelow: root,
					beforeCommit: async () => {
						symlinkSync(elsewhere, join(root, 'dir', 'f.md'))
					},
				}),
			).rejects.toBeInstanceOf(UnsafeWritePathError)
			expect(readdirSync(elsewhere)).toEqual([])
			expect(readdirSync(join(root, 'dir'))).toEqual(['f.md'])
		})
	})
})
