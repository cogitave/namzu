import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { createRoleStore } from './role-store.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})
const home = () => {
	const root = mkdtempSync(join(tmpdir(), 'nrs-'))
	roots.push(root)
	return root
}

it('keeps a role per conversation, private, and reads it from another store over the same folder', () => {
	const h = home()
	const writer = createRoleStore({ home: h })
	expect(writer.read('c1')).toBeUndefined()
	expect(writer.write('c1', { role: 'orchestrator', by: 'studio-air', at: 5 })).toBe(true)
	expect(createRoleStore({ home: h }).read('c1')).toEqual({
		role: 'orchestrator',
		by: 'studio-air',
		at: 5,
	})
	expect(statSync(join(h, 'network', 'session-roles.json')).mode & 0o077).toBe(0)
})

it('replaces and clears a role', () => {
	const store = createRoleStore({ home: home() })
	store.write('c1', { role: 'one', by: 'a', at: 1 })
	store.write('c1', { role: 'two', by: 'b', at: 2 })
	expect(store.read('c1')?.role).toBe('two')
	store.write('c1', null)
	expect(store.read('c1')).toBeUndefined()
})

it('keeps the 64 most recent roles', () => {
	const store = createRoleStore({ home: home() })
	for (let i = 0; i < 70; i++) store.write(`c${i}`, { role: `r${i}`, by: 'a', at: i })
	expect(store.read('c0')).toBeUndefined()
	expect(store.read('c69')?.role).toBe('r69')
	expect(store.read('c6')?.role).toBe('r6')
})

it('treats a damaged file, or entries that do not fit, as an empty store', () => {
	const h = home()
	const store = createRoleStore({ home: h })
	store.write('c1', { role: 'ok', by: 'a', at: 1 })
	const file = join(h, 'network', 'session-roles.json')
	writeFileSync(file, 'not json')
	expect(store.read('c1')).toBeUndefined()
	writeFileSync(
		file,
		JSON.stringify({
			v: 1,
			roles: [
				{ conversationId: 'c1', role: 'x'.repeat(501), by: 'a', at: 1 },
				{ conversationId: 'c2', role: '', by: 'a', at: 1 },
				{ conversationId: 'c3', role: 'fine', by: 'a', at: 1 },
			],
		}),
	)
	expect(store.read('c1')).toBeUndefined()
	expect(store.read('c2')).toBeUndefined()
	expect(store.read('c3')?.role).toBe('fine')
	expect(readFileSync(file, 'utf8')).toContain('fine')
})
