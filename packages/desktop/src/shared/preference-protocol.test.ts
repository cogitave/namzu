import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	AGENT_CHANGEABLE_PREFERENCES,
	PREFERENCE_NOTIFICATION,
	readPreferenceRequest,
} from './preference-protocol.js'
import { SETTINGS_CATALOGUE } from './settings-catalogue.js'
import { DEFAULT_DESKTOP_SETTINGS } from './settings-protocol.js'

describe('the engine asking for a preference change', () => {
	it('uses the notification the engine sends', () => {
		expect(PREFERENCE_NOTIFICATION).toBe('namzu/desktop/preference')
	})

	it('accepts a listed key with a value it takes', () => {
		expect(readPreferenceRequest({ key: 'notificationSound', value: 'system' })).toEqual({
			notificationSound: 'system',
		})
		expect(readPreferenceRequest({ key: 'keepAwakeWhileWorking', value: true })).toEqual({
			keepAwakeWhileWorking: true,
		})
		expect(readPreferenceRequest({ key: 'notifyTaskComplete', value: 'off' })).toEqual({
			notifyTaskComplete: 'off',
		})
	})

	it('refuses a value the preference does not take', () => {
		expect(readPreferenceRequest({ key: 'notifyTaskComplete', value: 'badge' })).toBeUndefined()
		expect(readPreferenceRequest({ key: 'notificationSound', value: 'loud' })).toBeUndefined()
		expect(readPreferenceRequest({ key: 'attentionSignals', value: 'yes' })).toBeUndefined()
	})

	it('refuses every other preference, including the ones that decide what the app trusts or runs', () => {
		for (const key of [
			'browserCookies',
			'retrustOnConfigChange',
			'runOnStartup',
			'systemTray',
			'keepEngineUpToDate',
			'autoDownloadUpdates',
			'hardwareAcceleration',
			'terminalShell',
			'voiceInputAccepted',
			'quickEntryShortcut',
			'autoOpenFiles',
		])
			expect(
				readPreferenceRequest({ key, value: (DEFAULT_DESKTOP_SETTINGS as never)[key] }),
				key,
			).toBeUndefined()
	})

	it('refuses a frame that is not exactly a key and a value', () => {
		for (const bad of [
			undefined,
			null,
			'x',
			[],
			{ key: 'notificationSound' },
			{ key: 'notificationSound', value: 'none', extra: 1 },
			{ key: 3, value: 'none' },
		])
			expect(readPreferenceRequest(bad)).toBeUndefined()
	})

	it('lists only preferences that have a Notifications or Agent row in Settings', () => {
		for (const key of AGENT_CHANGEABLE_PREFERENCES) {
			const row = SETTINGS_CATALOGUE.find((entry) => entry.key === key)
			expect(row, key).toBeDefined()
			expect(['notifications', 'agent'], key).toContain(row?.section)
		}
	})

	it("repeats, in the engine's list, the name and default Settings shows for each", () => {
		const engine = readFileSync(
			join(__dirname, '../../../cli/src/config/agent-settings.ts'),
			'utf8',
		)
		for (const key of AGENT_CHANGEABLE_PREFERENCES) {
			const row = SETTINGS_CATALOGUE.find((entry) => entry.key === key)
			const block = engine.slice(engine.indexOf(`key: '${key}'`))
			expect(block.startsWith(`key: '${key}'`), key).toBe(true)
			const own = block.slice(0, block.indexOf('\n\t},'))
			expect(own, key).toContain(`label: '${row?.label}'`)
			const fallback = typeof row?.default === 'string' ? `'${row.default}'` : String(row?.default)
			expect(own, key).toContain(`default: ${fallback}`)
			if (row?.control.kind === 'select')
				for (const option of row.control.options)
					expect(engine, key).toContain(`{ value: '${option.value}', label: '${option.label}' }`)
		}
	})
})
