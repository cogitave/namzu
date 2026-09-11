import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { PluginSettingsStore } from './settings.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'namzu-plugin-settings-'))
	roots.push(home)
	return { home, store: new PluginSettingsStore(home) }
}

it('keeps the startup choice across stores without merging unrelated project plugins', () => {
	const { home, store } = fixture()
	const first = { rootDir: '/projects/a/.namzu/plugins/ledger', name: 'ledger' }
	const second = { ...first, rootDir: '/projects/b/.namzu/plugins/ledger' }
	const peer = new PluginSettingsStore(home)
	expect(store.read(first)).toBe(true)
	expect(readdirSync(home)).toEqual([])
	store.write(first, false)
	expect(peer.read(first)).toBe(false)
	expect(peer.read(second)).toBe(true)
	peer.write(second, false)
	store.write(first, true)
	expect(new PluginSettingsStore(home).read(second)).toBe(false)
	expect(peer.read(first)).toBe(true)
	expect(store.read({ ...first, name: 'different-plugin' })).toBe(true)
	const files = readdirSync(store.directory)
	expect(files).toHaveLength(2)
	for (const file of files) {
		expect(file).toMatch(/^[a-f0-9]{64}\.json$/)
		expect(JSON.parse(readFileSync(join(store.directory, file), 'utf8'))).toMatchObject({
			version: 1,
			name: 'ledger',
		})
	}
})

it.each([
	'{bad-json',
	JSON.stringify({ version: 1, name: 'ledger', rootDir: '/wrong-root', enabled: false }),
	'x'.repeat(64 * 1024 + 1),
])('refuses damaged settings instead of re-enabling a plugin', (contents) => {
	const { store } = fixture()
	const plugin = { name: 'ledger', rootDir: '/plugins/ledger' }
	store.write(plugin, false)
	const path = join(store.directory, readdirSync(store.directory)[0]!)
	writeFileSync(path, contents)
	expect(() => store.read(plugin)).toThrow('Could not read plugin setting')
	expect(() => store.write(plugin, true)).toThrow('Could not read plugin setting')
	expect(readFileSync(path, 'utf8')).toBe(contents)
})

it.skipIf(process.platform === 'win32')(
	'refuses a symlinked settings partition without changing its target',
	() => {
		const { home, store } = fixture()
		const outside = join(home, 'outside')
		mkdirSync(outside)
		symlinkSync(outside, store.directory, 'dir')
		const plugin = { name: 'ledger', rootDir: '/plugins/ledger' }
		expect(() => store.read(plugin)).toThrow('real directory')
		expect(() => store.write(plugin, false)).toThrow('real directory')
		expect(readdirSync(outside)).toEqual([])
	},
)
