import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readUnreadFile, writeUnreadFile } from './unread-file.js'

const directories: string[] = []
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const directory = () => {
	const path = mkdtempSync(join(tmpdir(), 'namzu-unread-file-'))
	directories.push(path)
	return path
}

it('keeps the ids across a write and a read, in a file of its own', () => {
	const root = directory()
	writeUnreadFile(root, ['a', 'b'])
	expect(readUnreadFile(root)).toEqual(['a', 'b'])
	expect(JSON.parse(readFileSync(join(root, 'unread-conversations.json'), 'utf8'))).toEqual({
		version: 1,
		ids: ['a', 'b'],
	})
})

it('reads nothing from a missing, damaged or foreign file instead of failing the start', () => {
	const root = directory()
	expect(readUnreadFile(root)).toEqual([])
	for (const body of ['not json', '[]', 'null', '{"ids":"a"}']) {
		writeFileSync(join(root, 'unread-conversations.json'), body)
		expect(readUnreadFile(root)).toEqual([])
	}
	writeFileSync(join(root, 'unread-conversations.json'), '{"ids":[1,"a",null]}')
	expect(readUnreadFile(root)).toEqual(['a'])
})
