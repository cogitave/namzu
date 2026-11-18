import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existingFolders } from './existing-folders.js'

let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-folders-'))
	mkdirSync(join(root, 'there'))
	writeFileSync(join(root, 'file.txt'), 'x')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('which folders exist', () => {
	it('answers the folders that are there, and not a file or a missing path', async () => {
		expect(
			await existingFolders([join(root, 'there'), join(root, 'gone'), join(root, 'file.txt')]),
		).toEqual([join(root, 'there')])
	})
	it('does not call a relative folder missing, since each project resolves it its own way', async () => {
		expect(await existingFolders(['../shared', 'docs'])).toEqual(['../shared', 'docs'])
	})
	it('refuses a request that is not a short list of paths', async () => {
		await expect(existingFolders('x')).rejects.toThrow()
		await expect(existingFolders([1])).rejects.toThrow()
		await expect(existingFolders([''])).rejects.toThrow()
		await expect(existingFolders(Array(201).fill('/a'))).rejects.toThrow()
	})
})
