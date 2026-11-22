import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readSettings } from './desktop-settings.js'
import {
	SETTING_SECTIONS,
	closestSettings,
	findSetting,
	listSettings,
	parseSettingText,
	planSettingChange,
	readSettingRow,
	renderSetting,
	renderSettingList,
	rowData,
} from './setting-cli.js'
import { numberFromText, parseDuration, parseTokens, rangeText } from './setting-values.js'
import { SETTING_DESCRIPTORS, type SettingDescriptor } from './settings-descriptors.js'
import { userConfigPath } from './user-config.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-setting-cli-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
const opts = () => ({ home, env: {} as NodeJS.ProcessEnv })

function entry(path: string): SettingDescriptor {
	const found = findSetting(path)
	if (!found) throw new Error(`no setting ${path}`)
	return found
}

describe('one source for the terminal and Desktop', () => {
	it('lists every described setting, with the default and range Desktop reads', () => {
		const { rows } = listSettings(opts())
		const desktop = readSettings(opts())
		expect(rows.map((row) => row.key).sort()).toEqual(SETTING_DESCRIPTORS.map((d) => d.path).sort())
		// Sections print in the order SETTING_SECTIONS names, so the list reads like the nav.
		const seen = [...new Set(rows.map((row) => row.section))]
		expect(seen).toEqual(SETTING_SECTIONS.filter((name) => seen.includes(name)))
		for (const row of rows) {
			const seen = desktop.descriptors.find((d) => d.path === row.key)
			expect(row.default, row.key).toEqual(seen?.default)
			expect(row.control, row.key).toEqual(seen?.control)
			expect(rowData(row).control, row.key).toEqual(seen?.control)
			// Every one is reachable by key.
			expect(readSettingRow(row.key, opts()).key).toBe(row.key)
		}
	})

	it('says which layer decides a value, and what is in force', () => {
		const row = readSettingRow('limits.maxResponseTokens', {
			...opts(),
			env: { NAMZU_MAX_OUTPUT_TOKENS: '4096' } as NodeJS.ProcessEnv,
		})
		expect(row.layer).toBe('env')
		const text = renderSetting(row, 'f')
		expect(text).toContain('In force: 4096')
		expect(text).toContain('Set by an environment variable (NAMZU_MAX_OUTPUT_TOKENS)')
		expect(rowData(row)).toMatchObject({ layer: 'env', effective: 4096 })
	})

	it('says so when a valid section has no rows', () => {
		const text = renderSettingList(listSettings(opts(), 'general').rows, 'f')
		expect(text).toContain('No settings in this section')
	})

	it('shows a setting added to the description in the list, in get and in what Desktop reads', () => {
		const fake: SettingDescriptor = {
			path: 'limits.fakeAddedForTest',
			label: 'A fake row',
			description: 'Only the test has this.',
			section: 'agent',
			control: { kind: 'number', min: 2, max: 9 },
			default: 4,
			appliesWhen: 'next-turn',
		}
		const list = SETTING_DESCRIPTORS as SettingDescriptor[]
		list.push(fake)
		try {
			const row = listSettings(opts()).rows.find((r) => r.key === fake.path)
			expect(row).toMatchObject({ default: 4, control: fake.control, appliesWhen: 'next-turn' })
			expect(readSettingRow(fake.path, opts()).label).toBe('A fake row')
			expect(renderSetting(readSettingRow(fake.path, opts()), 'f')).toContain('From 2 to 9.')
			expect(readSettings(opts()).descriptors.some((d) => d.path === fake.path)).toBe(true)
			expect(renderSettingList(listSettings(opts()).rows, 'f')).toContain(fake.path)
		} finally {
			list.pop()
		}
		expect(findSetting('limits.fakeAddedForTest')).toBeUndefined()
	})

	it('never prints a value for a file-only row', () => {
		const rows = listSettings(opts()).rows.filter((row) => row.fileOnly)
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) expect(row.value).toBeUndefined()
	})
})

describe('reading what was typed', () => {
	it('takes the same numbers, times and sizes as Desktop', () => {
		const time = { min: 0, max: 2_147_483_647, unit: 'ms' }
		expect(numberFromText('90s', time)).toEqual({ value: 90_000 })
		expect(numberFromText('2m', time)).toEqual({ value: 120_000 })
		expect(numberFromText('nope', time)).toEqual({
			error: 'Enter minutes and seconds, such as 5m or 90s.',
		})
		const size = { min: 100_000, max: 1_000_000, unit: 'tokens' }
		expect(numberFromText('786k', size)).toEqual({ value: 786_000 })
		expect(numberFromText('2m', size)).toEqual({ error: 'Enter 1m or less.' })
		expect(numberFromText('banana', { min: 1 })).toEqual({ error: 'Enter a number.' })
		expect(parseDuration('1h 30m')).toBe(5_400_000)
		expect(parseTokens('1.5m')).toBe(1_500_000)
		expect(rangeText(size)).toBe('From 100k to 1m.')
	})

	it('reads each control kind', () => {
		expect(parseSettingText(entry('quiet'), 'OFF')).toEqual({ value: false })
		expect(parseSettingText(entry('quiet'), 'maybe')).toEqual({ error: 'Choose on or off.' })
		const mode = entry('permissions.defaultMode')
		expect(parseSettingText(mode, 'bypass')).toEqual({ value: 'bypass' })
		const label =
			mode.control.kind === 'select'
				? (mode.control.options.find((o) => o.value === 'bypass')?.label as string)
				: ''
		expect(parseSettingText(mode, label.toUpperCase())).toEqual({ value: 'bypass' })
		const checks = SETTING_DESCRIPTORS.find((d) => d.control.kind === 'checks')
		if (checks?.control.kind === 'checks') {
			const first = checks.control.options[0]?.value as string
			expect(parseSettingText(checks, `${first}`)).toEqual({ value: [first] })
			expect(parseSettingText(checks, 'none')).toEqual({ value: [] })
		}
		expect(parseSettingText(entry('statusLine'), 'x', opts())).toMatchObject({
			error: expect.stringContaining(userConfigPath(opts())),
		})
	})
})

describe('changing a setting', () => {
	it('writes the user file and says when it applies', () => {
		const plan = planSettingChange('limits.maxIterations', '20', opts())
		expect(plan.ok).toBe(true)
		if (!plan.ok) return
		expect(plan.confirm).toBeUndefined()
		expect(plan.apply()).toBe(
			'Most steps per reply is now 20. Applies to new conversations. Open ones keep what they have.',
		)
		expect(readFileSync(userConfigPath(opts()), 'utf8')).toContain('maxIterations: 20')
		expect(readSettingRow('limits.maxIterations', opts())).toMatchObject({ set: true, value: 20 })
	})

	it('says computer use applies from the next message, and its denied apps to new conversations', () => {
		const on = planSettingChange('computerUse.enabled', 'on', opts())
		if (!on.ok) throw new Error(on.error)
		expect(on.apply()).toContain('Applies from your next message.')
		const apps = planSettingChange('computerUse.deniedApps', 'Mail', opts())
		if (!apps.ok) throw new Error(apps.error)
		expect(apps.apply()).toContain('Applies to new conversations. Open ones keep what they have.')
	})

	it('stores a time in milliseconds and shows it in minutes and seconds', () => {
		const plan = planSettingChange('limits.timeoutMs', '90s', opts())
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.apply()).toContain('is now 1m 30s.')
		expect(readFileSync(userConfigPath(opts()), 'utf8')).toContain('timeoutMs: 90000')
		const size = planSettingChange('compaction.autoCompactWindowTokens', '786k', opts())
		if (!size.ok) throw new Error(size.error)
		size.apply()
		expect(readFileSync(userConfigPath(opts()), 'utf8')).toContain(
			'autoCompactWindowTokens: 786000',
		)
	})

	it('refuses with the words Desktop uses, and leaves the file alone', () => {
		const refused = (key: string, text: string) => {
			const plan = planSettingChange(key, text, opts())
			if (plan.ok) throw new Error(`${key} ${text} was accepted`)
			return plan.error
		}
		expect(refused('workflow.maxConcurrency', '17')).toBe('Enter 16 or less.')
		expect(refused('limits.maxIterations', 'banana')).toBe('Enter a number.')
		expect(refused('model', 'auto')).toContain('routing setting below has a default model')
		expect(refused('browser.defaultProfile', 'Bad Name')).toContain('lowercase letters and digits')
		expect(refused('format', 'xml')).toMatch(/^Choose one of/)
		expect(existsSync(userConfigPath(opts()))).toBe(false)
	})

	it('asks first for a risky choice, not for a safe one, and not when there is nothing to clear', () => {
		const risky = planSettingChange('permissions.defaultMode', 'bypass', opts())
		expect(risky.ok && risky.confirm).toMatch(/comfortable with/)
		const safe = planSettingChange('permissions.defaultMode', 'plan', opts())
		expect(safe.ok && safe.confirm).toBeUndefined()
		const clear = planSettingChange('permissions.defaultMode', undefined, opts())
		expect(clear.ok && clear.confirm).toBeUndefined()
		// A cap removed asks; a cap set does not.
		const zero = planSettingChange('limits.maxIterations', '0', opts())
		expect(zero.ok && zero.confirm).toBeTruthy()
	})

	it('does not ask to save the value already saved', () => {
		const first = planSettingChange('permissions.defaultMode', 'bypass', opts())
		if (!first.ok) throw new Error(first.error)
		first.apply()
		const again = planSettingChange('permissions.defaultMode', 'bypass', opts())
		expect(again.ok && again.confirm).toBeUndefined()
		// Clearing goes back to the default, auto, which lets actions run without
		// asking: that is asked about too.
		const clear = planSettingChange('permissions.defaultMode', undefined, opts())
		if (!clear.ok) throw new Error(clear.error)
		expect(clear.confirm).toMatch(/comfortable with/)
		expect(clear.apply()).toContain('is back to its default')
		expect(readFileSync(userConfigPath(opts()), 'utf8')).not.toContain('defaultMode')
	})

	it('suggests the closest names for an unknown key', () => {
		expect(closestSettings('limits.maxIteratons')[0]).toBe('limits.maxIterations')
		// An abbreviation of the last part, and a key that exists under another name.
		expect(closestSettings('limits.maxItr')[0]).toBe('limits.maxIterations')
		expect(closestSettings('limits.helpersAtOnce')).toContain('workflow.maxConcurrency')
		expect(closestSettings('helpers at once')).toContain('workflow.maxConcurrency')
		const plan = planSettingChange('limits.maxIteratons', '3', opts())
		expect(plan.ok).toBe(false)
		if (!plan.ok) expect(plan.error).toContain('limits.maxIterations')
	})
})

describe('the list names the group a row sits under', () => {
	it('prints a heading over each group inside a section, and carries the group in the data', () => {
		const { rows } = listSettings(opts(), 'terminal')
		const text = renderSettingList(rows, 'f').split('\n')
		const heading = (words: string) => text.findIndex((line) => line.trim() === words)
		expect(heading('Terminal app: look')).toBeGreaterThan(text.indexOf('[terminal]'))
		expect(heading('Terminal app: message box')).toBeGreaterThan(heading('Terminal app: look'))
		expect(heading('Command line')).toBeGreaterThan(heading('Terminal app: message box'))
		expect(text.findIndex((line) => line.includes('tui.theme'))).toBeGreaterThan(
			heading('Terminal app: look'),
		)
		expect(text.findIndex((line) => line.includes('format'))).toBeGreaterThan(
			heading('Command line'),
		)
		const format = rows.find((row) => row.key === 'format')
		expect(rowData(format as (typeof rows)[number])).toMatchObject({
			group: 'command-line',
			groupLabel: 'Command line',
		})
		const updates = renderSettingList(listSettings(opts(), 'updates').rows, 'f')
		expect(updates).toContain('[updates]\n  Command line\n')
		// Every engine row sits under a heading the Settings page shows.
		const flows = listSettings(opts(), 'agent').rows.find((row) => row.key === 'workflow.enabled')
		expect(rowData(flows as (typeof rows)[number])).toMatchObject({
			group: 'helpers-workflows',
			groupLabel: 'Helpers and workflows',
		})
	})
})
