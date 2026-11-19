import { describe, expect, it } from 'vitest'
import { filePathParts } from './file-path-parts.js'

describe('filePathParts', () => {
	it('splits a project path on its last slash', () => {
		expect(filePathParts('src/app/a.ts')).toEqual({ name: 'a.ts', folder: 'src/app/' })
		expect(filePathParts('a.ts')).toEqual({ name: 'a.ts', folder: '' })
	})

	it('splits a Windows path on backslashes too, so the file name stays the name', () => {
		expect(filePathParts('src\\app\\a.ts')).toEqual({ name: 'a.ts', folder: 'src/app/' })
	})

	it('writes a file outside the project with the home folder as ~', () => {
		const path =
			'C:\\Users\\WDAGUtilityAccount\\AppData\\Roaming\\Namzu\\chats\\ada-kahve\\index.json'
		expect(filePathParts(path, 'C:\\work\\p')).toEqual({
			name: 'index.json',
			folder: '~/AppData/Roaming/Namzu/chats/ada-kahve/',
		})
	})

	it('writes an absolute path inside the project relative to it', () => {
		expect(filePathParts('/tmp/p/src/a.ts', '/tmp/p')).toEqual({ name: 'a.ts', folder: 'src/' })
	})

	it('keeps an absolute path outside the project and home as it is', () => {
		expect(filePathParts('/srv/data/a.md', '/tmp/p')).toEqual({
			name: 'a.md',
			folder: '/srv/data/',
		})
	})
})
