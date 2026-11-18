import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { SESSION_EXPORT_EVENT_TYPES } from '../integrations/telemetry/session-export.js'
import { PREFIX_KEYS, parsePrefix } from '../workspaces/prefix.js'
import { COMPOSER_TRIGGER_DEFAULTS } from './composer-triggers.js'
import { writeSetting } from './desktop-settings.js'
import { planSettingChange, readSettingRow, renderSetting } from './setting-cli.js'
import { findSetting } from './setting-cli.js'
import { eventSwitchValue, levelsValue, needsConfirmation, screensValue } from './setting-values.js'
import { SETTING_DESCRIPTORS } from './settings-descriptors.js'
import { userConfigPath } from './user-config.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-list-settings-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
const opts = () => ({ home, env: {} as NodeJS.ProcessEnv })
const saved = (): Record<string, unknown> => {
	try {
		return (parse(readFileSync(userConfigPath(opts()), 'utf8')) ?? {}) as Record<string, unknown>
	} catch {
		return {}
	}
}
/** Plans a change as `namzu config set` does and applies it. */
function set(key: string, text: string): string {
	const plan = planSettingChange(key, text, opts())
	if (!plan.ok) throw new Error(plan.error)
	return plan.apply()
}
const refusal = (key: string, text: string): string => {
	const plan = planSettingChange(key, text, opts())
	return plan.ok ? 'accepted' : plan.error
}
const descriptor = (path: string) => {
	const found = findSetting(path)
	if (!found) throw new Error(path)
	return found
}

describe('no row below is a raw JSON box any more', () => {
	it('uses a typed control for each of the six rows', () => {
		const kinds = Object.fromEntries(
			[
				'tui.notifications',
				'tui.workspacesPrefix',
				'composerTriggers.builtin',
				'toolResultScreens',
				'telemetry.sessionExport.eventTypes',
				'telemetry.sessionExport.redactors',
			].map((path) => [path, descriptor(path).control.kind]),
		)
		expect(kinds).toEqual({
			'tui.notifications': 'toggle-checks',
			'tui.workspacesPrefix': 'key',
			'composerTriggers.builtin': 'levels',
			toolResultScreens: 'screens',
			'telemetry.sessionExport.eventTypes': 'checks',
			'telemetry.sessionExport.redactors': 'toggle-list',
		})
	})
})

describe('tui.notifications', () => {
	const control = () => {
		const c = descriptor('tui.notifications').control
		if (c.kind !== 'toggle-checks') throw new Error('kind')
		return c
	}
	it('writes false for off, true for the usual pair, the list for any other choice', () => {
		expect(eventSwitchValue([], control())).toBe(false)
		expect(eventSwitchValue(['approval-required', 'turn-settled'], control())).toBe(true)
		expect(eventSwitchValue(['idle-prompt', 'turn-settled'], control())).toEqual([
			'turn-settled',
			'idle-prompt',
		])
	})
	it('saves what the words say, and the file holds that list', () => {
		set('tui.notifications', 'turn-settled, idle-prompt')
		expect((saved().tui as Record<string, unknown>).notifications).toEqual([
			'turn-settled',
			'idle-prompt',
		])
		set('tui.notifications', 'on')
		expect((saved().tui as Record<string, unknown>).notifications).toBe(true)
		set('tui.notifications', 'off')
		expect((saved().tui as Record<string, unknown>).notifications).toBe(false)
		writeSetting({ path: 'tui.notifications', value: ['idle-prompt'] }, opts())
		expect((saved().tui as Record<string, unknown>).notifications).toEqual(['idle-prompt'])
	})
	it('shows the choice in words and refuses an event that does not exist', () => {
		set('tui.notifications', 'turn-settled,idle-prompt')
		expect(readSettingRow('tui.notifications', opts()).valueText).toBe(
			'on: Turn finished, Waiting for you',
		)
		expect(refusal('tui.notifications', 'sometimes')).toMatch(/Choose from: turn-settled/)
		expect(readSettingRow('tui.notifications', opts()).defaultText).toBe('off')
	})
	it('says what idle-prompt is', () => {
		const idle = control().options.find((o) => o.value === 'idle-prompt')
		expect(idle?.help).toMatch(/minute of quiet/)
		expect(renderSetting(readSettingRow('tui.notifications', opts()), 'f')).toMatch(
			/minute of quiet/,
		)
	})
})

describe('tui.workspacesPrefix', () => {
	it('offers only keys the loader accepts, and none it refuses', () => {
		for (const key of PREFIX_KEYS) expect(parsePrefix(key), key).toBeDefined()
		for (const refused of ['ctrl+c', 'ctrl+d', 'ctrl+z', 'ctrl+i', 'ctrl+m', 'ctrl+h', 'ctrl+['])
			expect(PREFIX_KEYS).not.toContain(refused)
		expect(PREFIX_KEYS).toContain('ctrl+b')
		expect(PREFIX_KEYS).toContain('ctrl+space')
	})
	it('writes the key as chosen and refuses the others with the loader words', () => {
		set('tui.workspacesPrefix', 'Ctrl+G')
		expect((saved().tui as Record<string, unknown>).workspacesPrefix).toBe('ctrl+g')
		set('tui.workspacesPrefix', 'Ctrl + Space')
		expect((saved().tui as Record<string, unknown>).workspacesPrefix).toBe('ctrl+space')
		for (const bad of ['ctrl+c', 'ctrl+d', 'ctrl+z', 'tab', 'ctrl+i'])
			expect(refusal('tui.workspacesPrefix', bad), bad).toMatch(
				/ctrl\+ and a letter, or ctrl\+space \(not ctrl\+c, ctrl\+d, ctrl\+z/,
			)
		expect(readSettingRow('tui.workspacesPrefix', opts()).defaultText).toBe('Ctrl+B')
	})
})

describe('composerTriggers.builtin', () => {
	const control = () => {
		const c = descriptor('composerTriggers.builtin').control
		if (c.kind !== 'levels') throw new Error('kind')
		return c
	}
	it('lists the five triggers with the engine defaults', () => {
		expect(control().entries.map((e) => e.value)).toEqual([
			'hypermode',
			'workflow',
			'save-skill',
			'schedule',
			'max-effort',
		])
		expect(descriptor('composerTriggers.builtin').default).toEqual(COMPOSER_TRIGGER_DEFAULTS)
		expect(control().levels.map((l) => l.value)).toEqual(['arm', 'suggest', 'off'])
		for (const entry of control().entries) expect(entry.help).toBeTruthy()
	})
	it('leaves an entry out when it is set to its default, and the key when none is left', () => {
		expect(
			levelsValue({ hypermode: 'suggest', schedule: 'suggest' }, COMPOSER_TRIGGER_DEFAULTS),
		).toEqual({
			hypermode: 'suggest',
		})
		set('composerTriggers.builtin', 'hypermode=suggest, max-effort=arm')
		const block = () => (saved().composerTriggers as Record<string, unknown>)?.builtin
		expect(block()).toEqual({ hypermode: 'suggest', 'max-effort': 'arm' })
		set('composerTriggers.builtin', '{"hypermode":"arm","max-effort":"arm"}')
		expect(block()).toEqual({ 'max-effort': 'arm' })
		set('composerTriggers.builtin', '{"max-effort":"off"}')
		expect(saved().composerTriggers).toBeUndefined()
	})
	it('refuses an unknown trigger or level', () => {
		expect(refusal('composerTriggers.builtin', '{"telepathy":"arm"}')).toMatch(
			/Choose from: hypermode/,
		)
		expect(refusal('composerTriggers.builtin', 'hypermode=loud')).toMatch(
			/Choose a level for hypermode/,
		)
		expect(refusal('composerTriggers.builtin', '["arm"]')).toMatch(/Choose a level/)
	})
	it('words the value with the defaults filled in', () => {
		set('composerTriggers.builtin', 'schedule=arm')
		expect(readSettingRow('composerTriggers.builtin', opts()).valueText).toBe(
			'Hypermode Arm, Workflow Arm, Save as skill Arm, Schedule Arm, Maximum effort Off',
		)
	})
})

describe('toolResultScreens', () => {
	const control = () => {
		const c = descriptor('toolResultScreens').control
		if (c.kind !== 'screens') throw new Error('kind')
		return c
	}
	it('offers the screens the reader knows and the tools one of them lets through', () => {
		expect(control().options.map((o) => o.value)).toEqual(['correspondence', 'injection'])
		expect(control().passthrough).toMatchObject({
			screen: 'correspondence',
			field: 'passthroughTools',
		})
		expect(descriptor('toolResultScreens').default).toEqual(['correspondence'])
	})
	it('writes the shape the reader accepts', () => {
		const dflt = ['correspondence']
		expect(screensValue(['correspondence'], [], control(), dflt)).toBeUndefined()
		expect(screensValue(['correspondence', 'injection'], [], control(), dflt)).toEqual([
			'correspondence',
			'injection',
		])
		expect(screensValue(['correspondence'], [' a ', 'a', 'b'], control(), dflt)).toEqual([
			{ name: 'correspondence', passthroughTools: ['a', 'b'] },
		])
		expect(screensValue([], ['a'], control(), dflt)).toEqual([])
		set('toolResultScreens', 'injection, correspondence')
		expect(saved().toolResultScreens).toEqual(['injection', 'correspondence'])
		set(
			'toolResultScreens',
			'[{"name":"correspondence","passthroughTools":["web_search"]},"injection"]',
		)
		expect(saved().toolResultScreens).toEqual([
			{ name: 'correspondence', passthroughTools: ['web_search'] },
			'injection',
		])
		set('toolResultScreens', 'none')
		expect(saved().toolResultScreens).toEqual([])
		set('toolResultScreens', 'correspondence')
		expect(saved().toolResultScreens).toBeUndefined()
	})
	it('refuses what the reader refuses, in its words', () => {
		expect(refusal('toolResultScreens', 'telepathy')).toMatch(
			/Choose from: correspondence, injection/,
		)
		expect(refusal('toolResultScreens', '[{"name":"injection","passthroughTools":["x"]}]')).toMatch(
			/passthroughTools is not an option of the "injection" screen/,
		)
		expect(
			refusal('toolResultScreens', '[{"name":"correspondence","passthroughTools":"x"}]'),
		).toMatch(/must be a list of tool names/)
		expect(refusal('toolResultScreens', '[{"name":"correspondence","speed":1}]')).toMatch(
			/speed is not an option/,
		)
	})
	it('asks only when the new list drops a screen the default holds', () => {
		const entry = descriptor('toolResultScreens')
		expect(needsConfirmation(entry, [])).toBe(true)
		expect(needsConfirmation(entry, ['injection'])).toBe(true)
		expect(needsConfirmation(entry, ['correspondence', 'injection'])).toBe(false)
		expect(needsConfirmation(entry, [{ name: 'correspondence', passthroughTools: ['x'] }])).toBe(
			false,
		)
		expect(needsConfirmation(entry, undefined)).toBe(false)
		const plan = planSettingChange('toolResultScreens', 'none', opts())
		expect(plan.ok && plan.confirm).toMatch(/unchecked/)
	})
})

describe('telemetry.sessionExport.eventTypes', () => {
	const entry = () => descriptor('telemetry.sessionExport.eventTypes')
	it('takes its choices from the list the export filters by', () => {
		const control = entry().control
		if (control.kind !== 'checks') throw new Error('kind')
		expect(control.options.map((o) => o.value)).toEqual([...SESSION_EXPORT_EVENT_TYPES])
		expect(SESSION_EXPORT_EVENT_TYPES.length).toBeGreaterThan(40)
		expect(entry().default).toEqual([...SESSION_EXPORT_EVENT_TYPES])
		expect(entry().description).not.toMatch(/Empty means all/)
		expect(JSON.stringify(entry())).not.toContain('"message"]')
	})
	it('shows an absent key as All events', () => {
		expect(readSettingRow('telemetry.sessionExport.eventTypes', opts()).defaultText).toBe(
			'All events',
		)
	})
	it('saves the ticked types, and removes the key when every type is ticked', () => {
		const first = SESSION_EXPORT_EVENT_TYPES[0] as string
		set('telemetry.sessionExport.destination', '/tmp/out.jsonl')
		set('telemetry.sessionExport.eventTypes', `${first}, ${SESSION_EXPORT_EVENT_TYPES[1]}`)
		const block = () => (saved().telemetry as Record<string, any>).sessionExport
		expect(block().eventTypes).toEqual([first, SESSION_EXPORT_EVENT_TYPES[1]])
		set('telemetry.sessionExport.eventTypes', 'all')
		expect(block().eventTypes).toBeUndefined()
		expect(block().destination).toBe('/tmp/out.jsonl')
	})
	it('says plainly that an empty choice saves nothing', () => {
		set('telemetry.sessionExport.destination', '/tmp/out.jsonl')
		set('telemetry.sessionExport.eventTypes', 'none')
		expect(readSettingRow('telemetry.sessionExport.eventTypes', opts()).valueText).toBe(
			'none. Nothing will be saved.',
		)
	})
	it('refuses a type the export does not know', () => {
		expect(refusal('telemetry.sessionExport.eventTypes', 'message')).toMatch(/Choose from: /)
	})
})

describe('telemetry.sessionExport.redactors', () => {
	it('is one switch, on by default', () => {
		const entry = descriptor('telemetry.sessionExport.redactors')
		expect(entry.control).toEqual({ kind: 'toggle-list', on: ['secrets'], off: [] })
		expect(readSettingRow('telemetry.sessionExport.redactors', opts()).defaultText).toBe('on')
	})
	it('writes secrets for on and an empty list for off, and asks only for off', () => {
		const entry = descriptor('telemetry.sessionExport.redactors')
		set('telemetry.sessionExport.destination', '/tmp/out.jsonl')
		const block = () => (saved().telemetry as Record<string, any>).sessionExport
		const off = planSettingChange('telemetry.sessionExport.redactors', 'off', opts())
		expect(off.ok && off.confirm).toMatch(/secrets in a conversation are saved as they are/)
		set('telemetry.sessionExport.redactors', 'off')
		expect(block().redactors).toEqual([])
		const on = planSettingChange('telemetry.sessionExport.redactors', 'on', opts())
		expect(on.ok && on.confirm).toBeUndefined()
		set('telemetry.sessionExport.redactors', 'on')
		expect(block().redactors).toEqual(['secrets'])
		expect(needsConfirmation(entry, undefined)).toBe(false)
		expect(needsConfirmation(entry, ['secrets'])).toBe(false)
		expect(needsConfirmation(entry, [])).toBe(true)
	})
	it('refuses a list that is neither on nor off', () => {
		expect(refusal('telemetry.sessionExport.redactors', '["telepathy"]')).toBe('Choose on or off.')
	})
})

describe('every typed row is described in words by get', () => {
	it('says what it takes', () => {
		for (const path of [
			'tui.notifications',
			'tui.workspacesPrefix',
			'composerTriggers.builtin',
			'toolResultScreens',
			'telemetry.sessionExport.eventTypes',
			'telemetry.sessionExport.redactors',
		])
			expect(renderSetting(readSettingRow(path, opts()), 'f'), path).toMatch(/Takes:|Choices:/)
		expect(SETTING_DESCRIPTORS.filter((d) => d.control.kind === 'json').length).toBeLessThan(
			SETTING_DESCRIPTORS.length,
		)
	})
})
