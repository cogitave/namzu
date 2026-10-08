import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_DESKTOP_SETTINGS } from '../shared/settings-protocol.js'
import { DesktopSettingsStore } from './desktop-settings.js'

let directory: string
let file: string
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'namzu-desktop-settings-'))
	file = join(directory, 'desktop-settings.json')
})
afterEach(() => {
	rmSync(directory, { recursive: true, force: true })
})

it('starts on the documented defaults without writing anything', () => {
	const onError = vi.fn()
	const store = new DesktopSettingsStore({ file, onError })
	expect(store.get()).toEqual({
		startup: 'continue',
		retrustOnConfigChange: true,
		autoDownloadUpdates: true,
	})
	expect(onError).not.toHaveBeenCalled()
	expect(() => readFileSync(file)).toThrow()
})

it('validates a change, saves it atomically, and survives a restart', () => {
	const changes: unknown[] = []
	const store = new DesktopSettingsStore({
		file,
		onChange: (settings, previous) => changes.push([settings, previous]),
	})
	expect(store.set({ startup: 'home', autoDownloadUpdates: false })).toEqual({
		startup: 'home',
		retrustOnConfigChange: true,
		autoDownloadUpdates: false,
	})
	expect(changes).toHaveLength(1)
	expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
		version: 1,
		startup: 'home',
		retrustOnConfigChange: true,
		autoDownloadUpdates: false,
	})
	expect(new DesktopSettingsStore({ file }).get()).toMatchObject({
		startup: 'home',
		autoDownloadUpdates: false,
	})
})

it('does not notify or rewrite for a change that changes nothing', () => {
	const onChange = vi.fn()
	const store = new DesktopSettingsStore({ file, onChange })
	store.set({ startup: 'continue' })
	expect(onChange).not.toHaveBeenCalled()
	expect(() => readFileSync(file)).toThrow()
})

it('rejects unknown keys, wrong types and values outside the set, changing nothing', () => {
	const store = new DesktopSettingsStore({ file })
	for (const bad of [
		{ nope: true },
		{ startup: 'later' },
		{ retrustOnConfigChange: 'yes' },
		{ autoDownloadUpdates: 1 },
		null,
		[],
		'startup',
	])
		expect(() => store.set(bad)).toThrow()
	// A valid key beside an unknown one refuses the whole request.
	expect(() => store.set({ startup: 'home', extra: 1 })).toThrow('Unknown setting')
	expect(store.get()).toEqual(DEFAULT_DESKTOP_SETTINGS)
	expect(() => readFileSync(file)).toThrow()
})

it('reads a damaged or hand-edited file entry by entry and reports it once', () => {
	const onError = vi.fn()
	writeFileSync(file, '{not json')
	expect(new DesktopSettingsStore({ file, onError }).get()).toEqual(DEFAULT_DESKTOP_SETTINGS)
	expect(onError).toHaveBeenCalledTimes(1)
	writeFileSync(
		file,
		JSON.stringify({ version: 1, startup: 'home', retrustOnConfigChange: 'nope', extra: 1 }),
	)
	expect(new DesktopSettingsStore({ file }).get()).toEqual({
		...DEFAULT_DESKTOP_SETTINGS,
		startup: 'home',
	})
})

it('keeps the old values and says why when the file cannot be written', () => {
	const onError = vi.fn()
	const onChange = vi.fn()
	// A regular file where the folder should be makes the write fail on every platform.
	const blocker = join(directory, 'blocker')
	writeFileSync(blocker, 'x')
	const store = new DesktopSettingsStore({
		file: join(blocker, 'settings.json'),
		onError,
		onChange,
	})
	expect(() => store.set({ startup: 'home' })).toThrow('could not save')
	expect(store.get().startup).toBe('continue')
	expect(onChange).not.toHaveBeenCalled()
	expect(onError).toHaveBeenCalledWith(expect.anything(), 'write')
})
