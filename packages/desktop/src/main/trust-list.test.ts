import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineTrustList } from './trust-list.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-trust-'))
})
const write = (value: unknown) =>
	writeFileSync(join(home, 'trust.json'), typeof value === 'string' ? value : JSON.stringify(value))

describe('the engine trust list', () => {
	it('is empty when the file is not there, and names the file', () => {
		const view = new EngineTrustList(home).view()
		expect(view).toEqual({ file: join(home, 'trust.json'), folders: [] })
	})

	it('lists the entries the command line wrote, ignoring anything that is not text', () => {
		write({ version: 1, trusted: ['/a', 7, '/b/c'] })
		expect(new EngineTrustList(home).view().folders).toEqual(['/a', '/b/c'])
	})

	it('removes exactly the named entry, in the shape the command line reads, and leaves a parent alone', () => {
		write({ version: 1, trusted: ['/work', '/work/app', '/other'] })
		const list = new EngineTrustList(home)
		expect(list.remove('/work/app').folders).toEqual(['/work', '/other'])
		const stored = JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8'))
		expect(stored).toEqual({ version: 1, trusted: ['/work', '/other'] })
		expect(readdirSync(home)).toEqual(['trust.json'])
	})

	it('refuses an entry that is not on the list and changes nothing', () => {
		write({ version: 1, trusted: ['/a'] })
		const list = new EngineTrustList(home)
		expect(() => list.remove('/b')).toThrow('no longer on the list')
		expect(() => list.remove(42)).toThrow('Invalid folder')
		expect(list.view().folders).toEqual(['/a'])
	})

	it('says a damaged file is unreadable and never rewrites it', () => {
		write('{ not json')
		const onError = vi.fn()
		const list = new EngineTrustList(home, onError)
		expect(list.view().unreadable).toBe(true)
		expect(() => list.remove('/a')).toThrow('could not be read')
		expect(readFileSync(join(home, 'trust.json'), 'utf8')).toBe('{ not json')
		expect(onError).toHaveBeenCalled()
		expect(existsSync(join(home, 'trust.json'))).toBe(true)
	})
})
