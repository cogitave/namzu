import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLockSync } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineTrustList } from './trust-list.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-trust-'))
})
afterEach(() => {
	rmSync(home, { recursive: true, force: true })
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
		// The list as it was is kept in backups/; nothing else is left beside the file.
		expect(readdirSync(home).sort()).toEqual(['backups', 'trust.json'])
		const [copy] = readdirSync(join(home, 'backups'))
		expect(copy).toMatch(/^trust\.json\.backup\.\d+$/)
		expect(JSON.parse(readFileSync(join(home, 'backups', copy as string), 'utf8')).trusted).toEqual(
			['/work', '/work/app', '/other'],
		)
		if (process.platform !== 'win32')
			expect(statSync(join(home, 'backups', copy as string)).mode & 0o777).toBe(0o600)
	})

	it('keeps entries it does not show and keys it does not know when it removes one', () => {
		write({ version: 1, trusted: ['/a', 7, '/b'], note: 'kept' })
		new EngineTrustList(home).remove('/a')
		expect(JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8'))).toEqual({
			version: 1,
			trusted: [7, '/b'],
			note: 'kept',
		})
	})

	it('waits for the engine holding the same lock, and refuses while it is still held', () => {
		write({ version: 1, trusted: ['/a', '/b'] })
		const file = join(home, 'trust.json')
		const waits: number[] = []
		const list = new EngineTrustList(home, undefined, (n) => void waits.push(n))
		// The SDK's own lock, as the command line takes it: Desktop must not write under it.
		expect(() => withFileLockSync(`${file}.lock`, () => list.remove('/a'))).toThrow(
			'saving this list in another window',
		)
		expect(waits.length).toBeGreaterThan(0)
		expect(JSON.parse(readFileSync(file, 'utf8')).trusted).toEqual(['/a', '/b'])
		expect(existsSync(`${file}.lock`)).toBe(false)
	})

	it('takes over a lock whose process has exited, as the engine would', () => {
		write({ version: 1, trusted: ['/a', '/b'] })
		const file = join(home, 'trust.json')
		writeFileSync(`${file}.lock`, `${2 ** 22 + 99}:0:gone`)
		expect(new EngineTrustList(home).remove('/a').folders).toEqual(['/b'])
		expect(existsSync(`${file}.lock`)).toBe(false)
		// And the engine can take the lock Desktop let go of.
		expect(withFileLockSync(`${file}.lock`, () => 'ok')).toBe('ok')
	})

	it('reads a newer version of the list as unreadable and never rewrites it', () => {
		write({ version: 2, trusted: ['/a'] })
		const list = new EngineTrustList(home)
		expect(list.view().unreadable).toBe(true)
		expect(() => list.remove('/a')).toThrow('could not be read')
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
