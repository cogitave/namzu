import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as yamlParse } from 'yaml'

import { checkSetting, readSettings, writeSetting } from './desktop-settings.js'
import {
	describeSetting,
	findSetting,
	parseSettingText,
	planSettingChange,
	readSettingRow,
} from './setting-cli.js'
import {
	autoModeAsks,
	autoModeConfirmation,
	autoModeLoosened,
	autoModeSet,
	listControlWords,
	needsConfirmation,
	routingForm,
	routingTarget,
	routingValue,
	timeoutFromSeconds,
} from './setting-values.js'
import { userConfigPath } from './user-config.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-models-settings-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
const opts = (env: NodeJS.ProcessEnv = {}) => ({ home, env })
const seed = (text: string) => {
	mkdirSync(dirname(userConfigPath(opts())), { recursive: true })
	writeFileSync(userConfigPath(opts()), text)
}
const saved = (): Record<string, unknown> =>
	(yamlParse(readFileSync(userConfigPath(opts()), 'utf8')) ?? {}) as Record<string, unknown>
const entry = (path: string) => {
	const found = findSetting(path)
	if (!found) throw new Error(path)
	return found
}

describe('routing as a form', () => {
	it('splits provider/model at the first slash and keeps a model with slashes of its own', () => {
		expect(routingTarget(' anthropic/claude-haiku-4-5 ')).toEqual({
			provider: 'anthropic',
			model: 'claude-haiku-4-5',
		})
		expect(routingTarget('openrouter/meta-llama/llama-3')).toEqual({
			provider: 'openrouter',
			model: 'meta-llama/llama-3',
		})
		expect(routingTarget('claude')).toEqual({ provider: '', model: 'claude' })
	})

	it('writes exactly the table the loader reads, in the loader order', () => {
		const built = routingValue(
			{
				default: 'anthropic/a',
				fast: 'anthropic/b',
				big: 'openai/c',
				strategy: 'score',
				timeout: '2.5',
			},
			{ thresholds: { fast: 0.9 } },
		)
		expect(built).toEqual({
			value: {
				default: { provider: 'anthropic', model: 'a' },
				tiers: {
					fast: { provider: 'anthropic', model: 'b' },
					big: { provider: 'openai', model: 'c' },
				},
				strategy: 'score',
				thresholds: { fast: 0.9 },
				timeoutMs: 2500,
			},
		})
		writeSetting({ path: 'routing', value: (built as { value: unknown }).value }, opts())
		expect(saved().routing).toEqual((built as { value: unknown }).value)
		// And the form reads the saved table back as it was typed.
		expect(routingForm(saved().routing)).toEqual({
			default: 'anthropic/a',
			fast: 'anthropic/b',
			big: 'openai/c',
			strategy: 'score',
			timeout: '2.5',
		})
	})

	it('leaves out what the form leaves empty', () => {
		expect(
			routingValue({ default: 'a/b', fast: '', big: '', strategy: '', timeout: '' }, undefined),
		).toEqual({ value: { default: { provider: 'a', model: 'b' } } })
	})

	it('reads the timeout as seconds and refuses what the loader would', () => {
		expect(timeoutFromSeconds('1.5')).toEqual({ value: 1500 })
		expect(timeoutFromSeconds('10')).toEqual({ value: 10_000 })
		expect(timeoutFromSeconds('')).toEqual({ value: undefined })
		for (const bad of ['0', '-1', '11', 'soon', '1.2345'])
			expect(timeoutFromSeconds(bad), bad).toEqual({
				error: 'Enter seconds from 0.001 to 10, such as 1.5.',
			})
	})

	it('refuses an empty default and a default with no provider in the loader words', () => {
		const empty = routingValue({ default: '', fast: '', big: '', strategy: '', timeout: '' })
		expect(() =>
			checkSetting({ path: 'routing', value: (empty as { value: unknown }).value }, opts()),
		).toThrow(/default is required/)
		const bare = routingValue({ default: 'claude', fast: '', big: '', strategy: '', timeout: '' })
		expect(() =>
			checkSetting({ path: 'routing', value: (bare as { value: unknown }).value }, opts()),
		).toThrow(/provider must be a non-empty string/)
		expect(existsSync(userConfigPath(opts()))).toBe(false)
	})

	it('refuses a strategy, a tier and a key the loader does not know', () => {
		const target = { provider: 'a', model: 'b' }
		expect(() =>
			checkSetting({ path: 'routing', value: { default: target, strategy: 'vibes' } }, opts()),
		).toThrow(/"yesno" or "score"/)
		expect(() =>
			checkSetting(
				{ path: 'routing', value: { default: target, tiers: { huge: target } } },
				opts(),
			),
		).toThrow(/not a routing tier/)
		expect(() =>
			checkSetting({ path: 'routing', value: { default: target, timeoutMs: 20_000 } }, opts()),
		).toThrow(/1 to 10000/)
		expect(() => checkSetting({ path: 'routing', value: [1] }, opts())).toThrow(/routing form/)
	})

	it('keeps the rule that Automatic needs the routing default', () => {
		seed('model: auto\nrouting:\n  default:\n    provider: a\n    model: b\n')
		expect(() => writeSetting({ path: 'routing' }, opts())).toThrow(/needs a default model/)
		expect(() => checkSetting({ path: 'routing', value: { strategy: 'score' } }, opts())).toThrow(
			/needs a default model in routing/,
		)
	})

	it('words the saved table, and the terminal takes it as JSON', () => {
		const control = entry('routing').control
		expect(
			listControlWords(control, {
				default: { provider: 'a', model: 'b' },
				tiers: { big: { provider: 'c', model: 'd' } },
				strategy: 'yesno',
				timeoutMs: 1500,
			}),
		).toBe('default a/b; large c/d; strategy yesno; timeout 1.5s')
		const parsed = parseSettingText(
			entry('routing'),
			'{"default":{"provider":"a","model":"b"}}',
			opts(),
		)
		expect(parsed).toEqual({ value: { default: { provider: 'a', model: 'b' } } })
		expect(parseSettingText(entry('routing'), 'a/b', opts())).toMatchObject({
			error: expect.stringContaining('Give JSON'),
		})
	})

	it('has an example the loader accepts', () => {
		const control = entry('routing').control
		if (control.kind !== 'routing') throw new Error('not a routing control')
		expect(() =>
			checkSetting({ path: 'routing', value: JSON.parse(control.example) }, opts()),
		).not.toThrow()
	})
})

describe('the small model', () => {
	it('is a model, saved as written and refused when it holds a space', () => {
		expect(entry('smallModel').control.kind).toBe('model')
		writeSetting({ path: 'smallModel', value: ' anthropic/claude-haiku-4-5 ' }, opts())
		expect(saved().smallModel).toBe('anthropic/claude-haiku-4-5')
		writeSetting({ path: 'smallModel', value: 'claude-haiku-4-5' }, opts())
		expect(saved().smallModel).toBe('claude-haiku-4-5')
		expect(() => writeSetting({ path: 'smallModel', value: 'two words' }, opts())).toThrow(
			/must be a model id/,
		)
		expect(saved().smallModel).toBe('claude-haiku-4-5')
		writeSetting({ path: 'smallModel' }, opts())
		expect(saved().smallModel).toBeUndefined()
	})

	it('says when NAMZU_SMALL_MODEL is set for the process, and only then', () => {
		const state = (env: NodeJS.ProcessEnv) =>
			readSettings(opts(env)).settings.find((s) => s.path === 'smallModel')
		expect(state({})?.env).toBeUndefined()
		expect(state({ NAMZU_SMALL_MODEL: '  ' })?.env).toBeUndefined()
		expect(state({ NAMZU_SMALL_MODEL: 'acme/small' })?.env).toEqual({
			variable: 'NAMZU_SMALL_MODEL',
			value: 'acme/small',
		})
		// Beside a saved value too, and no other row carries one.
		seed('smallModel: other\n')
		const snapshot = readSettings(opts({ NAMZU_SMALL_MODEL: 'acme/small' }))
		expect(snapshot.settings.find((s) => s.path === 'smallModel')).toMatchObject({
			set: true,
			value: 'other',
			env: { variable: 'NAMZU_SMALL_MODEL' },
		})
		expect(snapshot.settings.filter((s) => s.env).map((s) => s.path)).toEqual(['smallModel'])
	})

	it('prints the note in namzu config get', () => {
		const text = describeSetting('smallModel', opts({ NAMZU_SMALL_MODEL: 'acme/small' }))
		expect(text).toContain('NAMZU_SMALL_MODEL is set to acme/small')
		expect(describeSetting('smallModel', opts())).not.toContain('NAMZU_SMALL_MODEL is set')
		expect(readSettingRow('smallModel', opts()).env).toBeUndefined()
	})
})

describe('the auto mode reviewer', () => {
	const key = 'permissions.autoMode'

	it('writes the model and each list under permissions.autoMode and nothing else', () => {
		seed('permissions:\n  defaultMode: prompt\n  disableBypassMode: true\n  Bash: [allow]\n')
		const value = {
			model: 'smallModel',
			allow: ['$defaults', 'Run the test suite'],
			softDeny: ['$defaults'],
			hardDeny: ['$defaults', 'Delete a production database'],
			environment: ['The staging cluster'],
		}
		writeSetting({ path: key, value }, opts())
		const permissions = saved().permissions as Record<string, unknown>
		expect(permissions.autoMode).toEqual(value)
		expect(permissions.defaultMode).toBe('prompt')
		expect(permissions.disableBypassMode).toBe(true)
		expect(permissions.Bash).toEqual(['allow'])
	})

	it('takes a bare model, provider/model and the side model word, as the loader does', () => {
		for (const model of ['claude-haiku-4-5', 'anthropic/claude-haiku-4-5', 'smallModel']) {
			writeSetting({ path: key, value: { model } }, opts())
			expect((saved().permissions as { autoMode: { model: string } }).autoMode.model).toBe(model)
		}
	})

	it('refuses a list that is not sentences and a key it does not know', () => {
		expect(() => checkSetting({ path: key, value: { allow: 'x' } }, opts())).toThrow(
			/Always allowed must be a list of sentences/,
		)
		expect(() => checkSetting({ path: key, value: { hardDeny: ['  '] } }, opts())).toThrow(
			/Each entry of Always blocked/,
		)
		expect(() => checkSetting({ path: key, value: { soft: ['x'] } }, opts())).toThrow(
			/not an auto mode setting/,
		)
		expect(() => checkSetting({ path: key, value: 'x' }, opts())).toThrow(/reviewer form/)
	})

	it('treats an empty table as no table, and clears only autoMode', () => {
		seed('permissions:\n  defaultMode: prompt\n  autoMode:\n    model: smallModel\n')
		writeSetting({ path: key, value: {} }, opts())
		expect(saved().permissions).toEqual({ defaultMode: 'prompt' })
	})

	it('has an example the loader accepts', () => {
		const control = entry(key).control
		if (control.kind !== 'auto-mode') throw new Error('not an auto-mode control')
		expect(() =>
			checkSetting({ path: key, value: JSON.parse(control.example) }, opts()),
		).not.toThrow()
	})

	it('names what a change lets through: added allowed or trusted entries, removed blocks', () => {
		const held = { hardDeny: ['$defaults', 'A'], allow: ['X'] }
		expect(autoModeLoosened(held, held)).toEqual([])
		expect(autoModeLoosened(held, { ...held, allow: ['X', 'Y'] })).toEqual([
			{ field: 'allow', entries: ['Y'] },
		])
		expect(autoModeLoosened(held, { ...held, hardDeny: ['$defaults'] })).toEqual([
			{ field: 'hardDeny', entries: ['A'] },
		])
		expect(autoModeLoosened(held, { ...held, hardDeny: ['A'] })).toEqual([
			{ field: 'hardDeny', entries: ['$defaults'] },
		])
		// Only restricting never asks.
		expect(autoModeAsks(held, { ...held, hardDeny: ['$defaults', 'A', 'B'], allow: [] })).toBe(
			false,
		)
		expect(autoModeAsks(held, { ...held, softDeny: ['$defaults', 'C'] })).toBe(false)
		// A list left out is the built-in rules: giving [] to a block list removes them.
		expect(autoModeLoosened(undefined, { softDeny: [] })).toEqual([
			{ field: 'softDeny', entries: ['$defaults'] },
		])
		expect(autoModeLoosened(undefined, { environment: ['Our CI'] })).toEqual([
			{ field: 'environment', entries: ['Our CI'] },
		])
		// Clearing is a loosening when the table held a customised block list.
		expect(autoModeAsks({ hardDeny: ['A'] }, undefined)).toBe(true)
		expect(autoModeAsks({ allow: ['$defaults'] }, undefined)).toBe(false)
		// Clearing a table that dropped the built-in allow list brings them back: more is allowed.
		expect(autoModeAsks({ allow: [] }, undefined)).toBe(true)
	})

	it('asks when the model changes, not when it is cleared or kept', () => {
		expect(autoModeAsks(undefined, { model: 'smallModel' })).toBe(true)
		expect(autoModeAsks({ model: 'a' }, { model: 'a' })).toBe(false)
		expect(autoModeAsks({ model: 'a' }, { model: 'b' })).toBe(true)
		expect(autoModeAsks({ model: 'a' }, undefined)).toBe(false)
	})

	it('puts the model and each entry in the sentence it asks', () => {
		const lists = [
			{ value: 'allow', label: 'Always allowed' },
			{ value: 'hardDeny', label: 'Always blocked' },
		]
		const text = autoModeConfirmation(
			'This decides which actions are approved without asking you.',
			{ hardDeny: ['$defaults', 'A'] },
			{ model: 'x/y', allow: ['$defaults', 'Run tests'], hardDeny: ['$defaults'] },
			lists,
		)
		expect(text).toContain('Reviewer model: x/y.')
		expect(text).toContain('Added to "Always allowed": Run tests.')
		expect(text).toContain('Removed from "Always blocked": A.')
	})

	it('asks first in the terminal with the same sentence, and not for a change that restricts', () => {
		seed('permissions:\n  autoMode:\n    hardDeny: [$defaults, A]\n')
		const loosen = planSettingChange(key, '{"hardDeny":["$defaults"]}', opts())
		expect(loosen).toMatchObject({ ok: true })
		if (loosen.ok) expect(loosen.confirm).toContain('Removed from "Always blocked": A.')
		const tighten = planSettingChange(key, '{"hardDeny":["$defaults","A","B"]}', opts())
		if (tighten.ok) expect(tighten.confirm).toBeUndefined()
		const clear = planSettingChange(key, undefined, opts())
		if (clear.ok) expect(clear.confirm).toContain('Always blocked')
	})

	it('says in words what is saved', () => {
		const control = entry(key).control
		expect(
			listControlWords(control, {
				model: 'smallModel',
				allow: ['$defaults', 'Run tests'],
				hardDeny: [],
			}),
		).toBe('model smallModel; Always allowed: Built-in rules, Run tests; Always blocked: none')
		expect(listControlWords(control, {})).toBe('built-in rules')
	})

	it('builds a table without the keys that were taken out', () => {
		expect(autoModeSet({ model: 'a', allow: ['x'] }, { model: undefined })).toEqual({
			allow: ['x'],
		})
		expect(autoModeSet({ model: 'a' }, { model: undefined })).toBeUndefined()
		expect(autoModeSet(undefined, { hardDeny: ['x'], model: 'm' })).toEqual({
			model: 'm',
			hardDeny: ['x'],
		})
	})

	it('uses the descriptor rule through needsConfirmation as well', () => {
		expect(needsConfirmation(entry(key), { allow: ['x'] }, undefined)).toBe(true)
		expect(needsConfirmation(entry(key), { hardDeny: ['$defaults', 'x'] }, undefined)).toBe(false)
	})
})

describe('what namzu config get says about the model rows', () => {
	it('names the form of each and when the reviewer asks', () => {
		expect(describeSetting('smallModel', opts())).toContain('Takes:    a model, as provider/model')
		expect(describeSetting('routing', opts())).toContain('Takes:    JSON, such as {"default"')
		const auto = describeSetting('permissions.autoMode', opts())
		expect(auto).toContain('the entry $defaults stands for the built-in rules')
		expect(auto).toContain('Always blocked')
		expect(auto).toContain('smallModel for the side model')
		expect(auto).toContain(
			'Asks:     when the model changes or a list lets more run without asking you',
		)
	})

	it('shows a saved table in words after a terminal write', () => {
		const plan = planSettingChange('routing', '{"default":{"provider":"a","model":"b"}}', opts())
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.apply()).toContain('Automatic routing is now default a/b.')
		expect(saved().routing).toEqual({ default: { provider: 'a', model: 'b' } })
	})
})
