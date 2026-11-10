import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearInstalledPending, notNewerThan, versionInName } from './updater-cache.js'

const folders: string[] = []
function cache(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-updater-cache-'))
	folders.push(dir)
	mkdirSync(join(dir, 'pending'))
	writeFileSync(join(dir, 'installer.exe'), 'the differential base')
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'pending', name), text)
	return dir
}
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('updater cache versions', () => {
	it('reads a version out of an installer name', () => {
		expect(versionInName('Namzu-Setup-0.2.10.exe')).toEqual([0, 2, 10])
		expect(versionInName('installer.exe')).toBeUndefined()
	})
	it('compares numerically, not as text', () => {
		expect(notNewerThan([0, 2, 9], [0, 2, 10])).toBe(true)
		expect(notNewerThan([0, 2, 10], [0, 2, 10])).toBe(true)
		expect(notNewerThan([0, 3, 0], [0, 2, 10])).toBe(false)
	})
})

describe('clearInstalledPending', () => {
	it('removes an installer that is not newer than the running version, with its descriptor', () => {
		const dir = cache({
			'Namzu-Setup-0.2.1.exe': 'old',
			'update-info.json': JSON.stringify({ fileName: 'Namzu-Setup-0.2.1.exe' }),
		})
		expect(clearInstalledPending(dir, '0.2.7')).toBe(1)
		expect(readdirSync(join(dir, 'pending'))).toEqual([])
		expect(existsSync(join(dir, 'installer.exe'))).toBe(true)
	})

	it('keeps a downloaded update that is newer than the running version', () => {
		const dir = cache({
			'Namzu-Setup-0.3.0.exe': 'new',
			'update-info.json': JSON.stringify({ fileName: 'Namzu-Setup-0.3.0.exe' }),
		})
		expect(clearInstalledPending(dir, '0.2.7')).toBe(0)
		expect(readdirSync(join(dir, 'pending')).sort()).toEqual([
			'Namzu-Setup-0.3.0.exe',
			'update-info.json',
		])
	})

	it('judges installers by name when there is no descriptor, and ignores a missing folder', () => {
		const dir = cache({ 'Namzu-Setup-0.2.1.exe': 'old', 'Namzu-Setup-0.4.0.exe': 'new' })
		expect(clearInstalledPending(dir, '0.2.7')).toBe(1)
		expect(readdirSync(join(dir, 'pending'))).toEqual(['Namzu-Setup-0.4.0.exe'])
		expect(clearInstalledPending(join(dir, 'nowhere'), '0.2.7')).toBe(0)
		expect(clearInstalledPending(dir, 'unknown')).toBe(0)
	})
})
