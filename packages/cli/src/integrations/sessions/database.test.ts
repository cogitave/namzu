import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateTenantId } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { sessionDatabasePath, sessionStore } from './database.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})
function temporary(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-database-boundary-'))
	roots.push(root)
	return root
}

it('read-only admission does not initialize an absent state directory', () => {
	const root = temporary()
	expect(() => sessionStore(root, true)).toThrow()
	expect(existsSync(join(root, 'state'))).toBe(false)
})

it('refuses an aliased state directory on inspection as well as writing', () => {
	const root = temporary()
	const target = temporary()
	symlinkSync(target, join(root, 'state'), process.platform === 'win32' ? 'junction' : 'dir')
	expect(() => sessionStore(root)).toThrow(/real directory/)
	expect(() => sessionStore(root, true)).toThrow(/real state directory/)
})

it.each(['database', 'journal', 'hardlink'] as const)(
	'does not open an aliased %s file',
	(kind) => {
		const root = temporary()
		mkdirSync(join(root, 'state'))
		const target = join(root, 'original')
		writeFileSync(target, 'untouched')
		const path = sessionDatabasePath(root) + (kind === 'journal' ? '-journal' : '')
		if (kind === 'hardlink') linkSync(target, path)
		else symlinkSync(target, path)
		expect(() => sessionStore(root)).toThrow(/private regular file/)
		expect(readFileSync(target, 'utf8')).toBe('untouched')
	},
)

it('refuses corrupt SQLite data instead of minting a replacement project', async () => {
	const root = temporary()
	mkdirSync(join(root, 'state'))
	const path = sessionDatabasePath(root)
	writeFileSync(path, 'corrupt database')
	const tenantId = generateTenantId()
	await expect(
		sessionStore(root).createProject({ tenantId, name: 'refuse' }, tenantId),
	).rejects.toThrow()
	expect(readFileSync(path, 'utf8')).toBe('corrupt database')
	expect(existsSync(join(root, 'projects'))).toBe(false)
})
