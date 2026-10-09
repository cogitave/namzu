import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { palFolderToReveal } from './pal-folder.js'

const made: string[] = []
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'pal-folder-'))
	made.push(dir)
	return dir
}

it('reveals an existing absolute directory', async () => {
	const dir = temp()
	expect(await palFolderToReveal(dir)).toBe(realpathSync(dir))
})

it('refuses anything that is not an existing absolute directory', async () => {
	const dir = temp()
	const file = join(dir, 'note.txt')
	writeFileSync(file, 'x')
	for (const bad of [undefined, 42, '', 'relative/path', `${dir}\0`])
		await expect(palFolderToReveal(bad)).rejects.toThrow('no folder to open')
	await expect(palFolderToReveal(file)).rejects.toThrow('does not exist')
	await expect(palFolderToReveal(join(dir, 'gone'))).rejects.toThrow('does not exist')
})
