import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { StateFileUnreadableError } from '../state/state-file.js'
import {
	installedPluginsPath,
	knownMarketplacesPath,
	putInstallRecord,
	putKnownMarketplace,
	readInstalledPlugins,
	readKnownMarketplaces,
	removeInstallRecord,
	removeKnownMarketplace,
} from './records.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-records-'))
})
afterEach(() => removeTempDir(home))

const cache = (...parts: string[]) => join(home, 'plugins', 'cache', ...parts)

describe('installed_plugins.json', () => {
	it('reads as empty when there is no file', () => {
		const read = readInstalledPlugins(home)
		expect(read.state).toBe('missing')
		expect(read.state !== 'unreadable' && read.plugins.size).toBe(0)
	})

	it('writes version 2 and reads the record back, one per scope and folder', () => {
		putInstallRecord(home, 'ledger@m', { scope: 'user', installPath: cache('m', 'ledger', '1') })
		putInstallRecord(home, 'ledger@m', {
			scope: 'project',
			projectPath: '/work/app',
			installPath: cache('m', 'ledger', '1'),
		})
		putInstallRecord(home, 'ledger@m', {
			scope: 'project',
			projectPath: '/work/app',
			installPath: cache('m', 'ledger', '2'),
			version: '2',
		})
		const raw = JSON.parse(readFileSync(installedPluginsPath(home), 'utf8'))
		expect(raw.version).toBe(2)
		const read = readInstalledPlugins(home)
		if (read.state === 'unreadable') throw new Error('unreadable')
		const records = read.plugins.get('ledger@m') ?? []
		expect(records.map((r) => [r.scope, r.version])).toEqual([
			['user', undefined],
			['project', '2'],
		])
	})

	it('keeps a key it does not know when a record changes', () => {
		mkdirSync(join(home, 'plugins'), { recursive: true })
		writeFileSync(
			installedPluginsPath(home),
			JSON.stringify({
				version: 2,
				future: { keep: true },
				plugins: { 'a@m': [{ scope: 'user', installPath: cache('m', 'a', '1'), extra: 'kept' }] },
			}),
		)
		putInstallRecord(home, 'a@m', {
			scope: 'user',
			installPath: cache('m', 'a', '2'),
			version: '2',
		})
		const raw = JSON.parse(readFileSync(installedPluginsPath(home), 'utf8'))
		expect(raw.future).toEqual({ keep: true })
		expect(raw.plugins['a@m'][0]).toMatchObject({ extra: 'kept', version: '2' })
	})

	it('blocks on a damaged file instead of replacing it, and keeps its bytes and a recovery copy', () => {
		mkdirSync(join(home, 'plugins'), { recursive: true })
		const path = installedPluginsPath(home)
		writeFileSync(path, '{ not json')
		expect(readInstalledPlugins(home)).toMatchObject({ state: 'unreadable' })
		let thrown: unknown
		try {
			putInstallRecord(home, 'a@m', { scope: 'user', installPath: cache('m', 'a', '1') })
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(StateFileUnreadableError)
		expect(readFileSync(path, 'utf8')).toBe('{ not json')
		const kept = readdirSync(join(home, 'backups'))
		expect(kept.some((name) => name.includes('installed_plugins.json.corrupted.'))).toBe(true)
		expect((thrown as StateFileUnreadableError).sentence((p) => p)).toContain('could not be read')
	})

	it('treats a newer version, or no version, as unreadable', () => {
		mkdirSync(join(home, 'plugins'), { recursive: true })
		writeFileSync(installedPluginsPath(home), JSON.stringify({ version: 3, plugins: {} }))
		expect(readInstalledPlugins(home)).toMatchObject({
			state: 'unreadable',
			reason: expect.stringContaining('newer'),
		})
		writeFileSync(installedPluginsPath(home), JSON.stringify({ plugins: {} }))
		expect(readInstalledPlugins(home).state).toBe('unreadable')
	})

	it('reports an entry that is not a record and keeps reading the others', () => {
		mkdirSync(join(home, 'plugins'), { recursive: true })
		writeFileSync(
			installedPluginsPath(home),
			JSON.stringify({
				version: 2,
				plugins: {
					'good@m': [{ scope: 'user', installPath: cache('m', 'good', '1') }],
					'bad@m': [{ scope: 'galaxy', installPath: 'relative' }],
					'not an id': [],
				},
			}),
		)
		const read = readInstalledPlugins(home)
		if (read.state === 'unreadable') throw new Error('unreadable')
		expect([...read.plugins.keys()]).toEqual(['good@m'])
		expect(read.invalid.map((bad) => bad.id).sort()).toEqual(['bad@m', 'not an id'])
	})

	it('removes one record and the id when its last record goes', () => {
		putInstallRecord(home, 'a@m', { scope: 'user', installPath: cache('m', 'a', '1') })
		putInstallRecord(home, 'a@m', {
			scope: 'local',
			projectPath: '/work/app',
			installPath: cache('m', 'a', '1'),
		})
		expect(removeInstallRecord(home, 'a@m', { scope: 'local', projectPath: '/work/app' })).toBe(
			true,
		)
		expect(removeInstallRecord(home, 'a@m', { scope: 'local', projectPath: '/work/app' })).toBe(
			false,
		)
		expect(removeInstallRecord(home, 'a@m', { scope: 'user' })).toBe(true)
		const raw = JSON.parse(readFileSync(installedPluginsPath(home), 'utf8'))
		expect(raw.plugins).toEqual({})
	})

	it('refuses an id or a record that is not valid', () => {
		expect(() =>
			putInstallRecord(home, 'no-marketplace', { scope: 'user', installPath: cache('x') }),
		).toThrow('plugin id')
		expect(() =>
			putInstallRecord(home, 'a@m', { scope: 'project', installPath: cache('x') }),
		).toThrow('projectPath')
	})
})

describe('known_marketplaces.json', () => {
	const directory = (path: string) => ({ source: 'directory', path })

	it('adds, reads and removes a marketplace and keeps keys it does not know', () => {
		putKnownMarketplace(home, 'team-tools', {
			source: directory('/src/team'),
			installLocation: '/src/team',
			future: 1,
		})
		putKnownMarketplace(home, 'team-tools', {
			source: directory('/src/team'),
			installLocation: '/src/team',
			autoUpdate: false,
		})
		const raw = JSON.parse(readFileSync(knownMarketplacesPath(home), 'utf8'))
		expect(raw['team-tools']).toMatchObject({ future: 1, autoUpdate: false })
		const read = readKnownMarketplaces(home)
		if (read.state === 'unreadable') throw new Error('unreadable')
		expect(read.marketplaces.get('team-tools')?.source.source).toBe('directory')
		expect(removeKnownMarketplace(home, 'team-tools')).toBe(true)
		expect(removeKnownMarketplace(home, 'team-tools')).toBe(false)
	})

	it('blocks on a damaged file and keeps it', () => {
		mkdirSync(join(home, 'plugins'), { recursive: true })
		writeFileSync(knownMarketplacesPath(home), '[1]')
		expect(readKnownMarketplaces(home).state).toBe('unreadable')
		expect(() =>
			putKnownMarketplace(home, 'm', { source: directory('/x'), installLocation: '/x' }),
		).toThrow(StateFileUnreadableError)
		expect(readFileSync(knownMarketplacesPath(home), 'utf8')).toBe('[1]')
	})

	it('reports a source kind it does not accept', () => {
		mkdirSync(join(home, 'plugins'), { recursive: true })
		writeFileSync(
			knownMarketplacesPath(home),
			JSON.stringify({
				npmish: { source: { source: 'npm', package: 'x' }, installLocation: '/x' },
			}),
		)
		const read = readKnownMarketplaces(home)
		if (read.state === 'unreadable') throw new Error('unreadable')
		expect(read.marketplaces.size).toBe(0)
		expect(read.invalid[0]?.reason).toContain('source kind')
	})
})
