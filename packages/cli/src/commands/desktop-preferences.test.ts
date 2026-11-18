import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	DESKTOP_PREFERENCE_NOTIFICATION,
	DESKTOP_SETTINGS_FILE_VARIABLE,
	desktopPreferencesBridge,
} from './desktop-preferences.js'
import { withPreviews } from './permission-preview.js'

describe('the desktop preferences bridge', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-desktop-prefs-'))
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('is absent when the app did not say where its preferences are', () => {
		expect(desktopPreferencesBridge({}, () => undefined)).toBeUndefined()
	})

	it('reads the app file, treats a missing file as nothing saved and a damaged one as unreadable', () => {
		const file = join(dir, 'desktop-settings.json')
		const bridge = desktopPreferencesBridge(
			{ [DESKTOP_SETTINGS_FILE_VARIABLE]: file },
			() => undefined,
		)
		expect(bridge?.read()).toEqual({})
		writeFileSync(file, JSON.stringify({ version: 1, notifyError: 'off' }))
		expect(bridge?.read()).toMatchObject({ notifyError: 'off' })
		writeFileSync(file, '{ not json')
		expect(bridge?.read()).toBeUndefined()
	})

	it('asks the app by notification and writes no file itself', () => {
		const file = join(dir, 'desktop-settings.json')
		const said: { method: string; params: Record<string, unknown> }[] = []
		const bridge = desktopPreferencesBridge(
			{ [DESKTOP_SETTINGS_FILE_VARIABLE]: file },
			(method, params) => said.push({ method, params }),
		)
		bridge?.write('notificationSound', 'system')
		expect(said).toEqual([
			{
				method: DESKTOP_PREFERENCE_NOTIFICATION,
				params: { key: 'notificationSound', value: 'system' },
			},
		])
		expect(bridge?.read()).toEqual({})
	})
})

describe('the permission card for a setting change', () => {
	const call = {
		id: 'c1',
		name: 'set_setting',
		input: { setting: 'x', value: true },
		isDestructive: false,
		requiresApproval: true,
	}

	it('carries the words the card shows, and the mark that it is always asked', async () => {
		const [card] = await withPreviews([call], [], {
			settingChange: () => ({ setting: 'Output style', from: 'not set', to: 'short' }),
		})
		expect(card).toMatchObject({
			alwaysAsk: true,
			settingChange: { setting: 'Output style', from: 'not set', to: 'short' },
		})
	})

	it('still asks when the words cannot be worked out', async () => {
		const [card] = await withPreviews([call], [], {
			settingChange: () => {
				throw new Error('boom')
			},
		})
		expect(card).toMatchObject({ alwaysAsk: true })
		expect(card).not.toHaveProperty('settingChange')
	})
})
