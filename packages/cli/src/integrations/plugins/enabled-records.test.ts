import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { KNOWN_FILE_KEYS, PLUGIN_RECORD_KEYS } from '../../config/load.js'
import { StateFileUnreadableError } from '../state/state-file.js'
import {
	type LayerReads,
	RECORD_KEY_CAP,
	readRecordLayer,
	recordLayerPath,
	resolveEnabled,
	setEnabledPlugin,
	setExtraKnownMarketplace,
} from './enabled-records.js'

let root: string
let home: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-enabled-'))
	home = join(root, 'home')
	cwd = join(root, 'app')
	mkdirSync(home, { recursive: true })
	mkdirSync(cwd, { recursive: true })
})
afterEach(() => removeTempDir(root))

const layer = (enabled: Record<string, boolean>): LayerReads['user'] => ({
	state: 'ok',
	enabledPlugins: new Map(Object.entries(enabled)),
	marketplaces: new Map(),
	ignored: [],
})

describe('the files', () => {
	it('puts the three layers where the data placement rule says', () => {
		expect(recordLayerPath('user', { home, cwd })).toBe(join(home, 'settings.json'))
		expect(recordLayerPath('project', { home, cwd })).toBe(join(cwd, '.namzu', 'settings.json'))
		expect(recordLayerPath('local', { home, cwd })).toBe(join(cwd, '.namzu', 'settings.local.json'))
	})

	it('lists the two keys as known file keys', () => {
		expect(PLUGIN_RECORD_KEYS).toEqual(['enabledPlugins', 'extraKnownMarketplaces'])
		for (const key of PLUGIN_RECORD_KEYS) expect(KNOWN_FILE_KEYS).toContain(key)
	})

	it('changes only its key and keeps every other key as written', () => {
		const path = recordLayerPath('local', { home, cwd })
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(
			path,
			JSON.stringify({ permissions: { Bash: 'allow' }, enabledPlugins: { 'a@m': true } }),
		)
		setEnabledPlugin(path, home, 'b@m', false)
		const raw = JSON.parse(readFileSync(path, 'utf8'))
		expect(raw.permissions).toEqual({ Bash: 'allow' })
		expect(raw.enabledPlugins).toEqual({ 'a@m': true, 'b@m': false })
		setEnabledPlugin(path, home, 'a@m', undefined)
		expect(JSON.parse(readFileSync(path, 'utf8')).enabledPlugins).toEqual({ 'b@m': false })
	})

	it('creates the user file with only the record', () => {
		const path = recordLayerPath('user', { home, cwd })
		setEnabledPlugin(path, home, 'a@m', true)
		expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ enabledPlugins: { 'a@m': true } })
		setExtraKnownMarketplace(path, home, 'team', { source: 'github', repo: 'acme/team' })
		const read = readRecordLayer(path)
		if (read.state === 'unreadable') throw new Error('unreadable')
		expect(read.marketplaces.get('team')?.source.repo).toBe('acme/team')
	})

	it('refuses to replace a file that does not read, and keeps it', () => {
		const path = recordLayerPath('user', { home, cwd })
		writeFileSync(path, '{ broken')
		expect(() => setEnabledPlugin(path, home, 'a@m', true)).toThrow(StateFileUnreadableError)
		expect(readFileSync(path, 'utf8')).toBe('{ broken')
	})

	it('leaves out a key that is not an id or a value that is not a yes or a no, and lists it', () => {
		const path = recordLayerPath('user', { home, cwd })
		writeFileSync(
			path,
			JSON.stringify({
				enabledPlugins: { 'a@m': true, 'bad key': true, 'b@m': ['x'] },
				extraKnownMarketplaces: { ok: { source: { source: 'directory', path: '/x' } }, nope: 3 },
			}),
		)
		const read = readRecordLayer(path)
		if (read.state === 'unreadable') throw new Error('unreadable')
		expect([...read.enabledPlugins.keys()]).toEqual(['a@m'])
		expect([...read.marketplaces.keys()]).toEqual(['ok'])
		expect([...read.ignored].sort()).toEqual([
			'enabledPlugins.b@m',
			'enabledPlugins.bad key',
			'extraKnownMarketplaces.nope',
		])
	})
})

describe('the 500 key cap', () => {
	const ids = (n: number) =>
		Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}@m`, true]))

	it('reads 500 keys and refuses a file with more', () => {
		const path = recordLayerPath('user', { home, cwd })
		writeFileSync(path, JSON.stringify({ enabledPlugins: ids(RECORD_KEY_CAP) }))
		expect(readRecordLayer(path).state).toBe('ok')
		writeFileSync(path, JSON.stringify({ enabledPlugins: ids(RECORD_KEY_CAP + 1) }))
		expect(readRecordLayer(path)).toMatchObject({
			state: 'unreadable',
			reason: expect.stringContaining('more than 500'),
		})
	})

	it('refuses to add the 501st key and still changes an existing one', () => {
		const path = recordLayerPath('user', { home, cwd })
		writeFileSync(path, JSON.stringify({ enabledPlugins: ids(RECORD_KEY_CAP) }))
		expect(() => setEnabledPlugin(path, home, 'extra@m', true)).toThrow('500')
		setEnabledPlugin(path, home, 'p0@m', false)
		expect(JSON.parse(readFileSync(path, 'utf8')).enabledPlugins['p0@m']).toBe(false)
		writeFileSync(
			path,
			JSON.stringify({
				extraKnownMarketplaces: Object.fromEntries(
					Array.from({ length: RECORD_KEY_CAP }, (_, i) => [
						`m${i}`,
						{ source: { source: 'directory', path: '/x' } },
					]),
				),
			}),
		)
		expect(() =>
			setExtraKnownMarketplace(path, home, 'more', { source: 'directory', path: '/y' }),
		).toThrow('500')
	})

	it('refuses an id that does not match the pattern', () => {
		const path = recordLayerPath('user', { home, cwd })
		expect(() => setEnabledPlugin(path, home, 'no-at-sign', true)).toThrow('plugin id')
		expect(() => setEnabledPlugin(path, home, '../x@m', true)).toThrow('plugin id')
	})
})

describe('who may say on', () => {
	it('lets the highest layer that speaks win: local, then project, then user', () => {
		const id = 'a@m'
		expect(resolveEnabled(id, { user: layer({ [id]: true }) }, true)).toEqual({
			on: true,
			by: 'user',
		})
		expect(
			resolveEnabled(id, { user: layer({ [id]: true }), project: layer({ [id]: false }) }, true),
		).toEqual({ on: false, by: 'project' })
		expect(
			resolveEnabled(
				id,
				{
					user: layer({ [id]: true }),
					project: layer({ [id]: false }),
					local: layer({ [id]: true }),
				},
				true,
			),
		).toEqual({ on: true, by: 'local' })
		expect(resolveEnabled(id, { user: layer({}), project: layer({}) }, true)).toEqual({ on: false })
	})

	it('does not count a project yes when this computer has nothing installed for the folder', () => {
		const id = 'a@m'
		expect(resolveEnabled(id, { project: layer({ [id]: true }) }, false)).toEqual({ on: false })
		// ...so a user answer below it still speaks.
		expect(
			resolveEnabled(id, { project: layer({ [id]: true }), user: layer({ [id]: false }) }, false),
		).toEqual({ on: false, by: 'user' })
		// A project no always counts.
		expect(
			resolveEnabled(id, { project: layer({ [id]: false }), user: layer({ [id]: true }) }, false),
		).toEqual({
			on: false,
			by: 'project',
		})
	})

	it('does not let a layer that did not read speak', () => {
		const id = 'a@m'
		expect(
			resolveEnabled(
				id,
				{ local: { state: 'unreadable', reason: 'x' }, user: layer({ [id]: true }) },
				true,
			),
		).toEqual({ on: true, by: 'user' })
	})
})
