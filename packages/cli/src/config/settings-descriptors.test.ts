import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { withDefaultText } from './desktop-settings.js'
import { CONFIG_KEYS } from './load.js'
import {
	APPLIES_WHEN_TEXT,
	SETTING_DESCRIPTORS,
	SETTING_EXCLUSIONS,
	type SettingDescriptor,
	appliesWhenFor,
} from './settings-descriptors.js'

const here = dirname(fileURLToPath(import.meta.url))

/** The property names of `interface NamzuCliConfig`, read from the source, not from a list. */
function namzuCliConfigKeys(): string[] {
	const file = join(here, 'schema.ts')
	const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
	const keys: string[] = []
	source.forEachChild((node) => {
		if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'NamzuCliConfig') return
		for (const member of node.members)
			if (ts.isPropertySignature(member) && member.name) keys.push(member.name.getText(source))
	})
	return keys
}

const optionValues = (entry: SettingDescriptor): string[] =>
	entry.control.kind === 'select' || entry.control.kind === 'checks'
		? entry.control.options.map((option) => option.value)
		: []

describe('the typed setting description', () => {
	it('has a description or a stated exclusion for every NamzuCliConfig key', () => {
		const keys = namzuCliConfigKeys()
		expect(keys.length).toBeGreaterThan(20)
		const described = new Set(SETTING_DESCRIPTORS.map((entry) => entry.path.split('.')[0]))
		const excluded = new Map(SETTING_EXCLUSIONS.map((entry) => [entry.key, entry.reason]))
		const missing = keys.filter((key) => !described.has(key) && !excluded.has(key))
		expect(missing, `NamzuCliConfig keys with no description and no exclusion: ${missing}`).toEqual(
			[],
		)
		for (const key of excluded.keys()) expect(keys).toContain(key)
		for (const key of CONFIG_KEYS) expect(keys).toContain(key)
	})

	it('names when every change applies, in a way a screen can say', () => {
		for (const entry of SETTING_DESCRIPTORS) {
			expect(Object.keys(APPLIES_WHEN_TEXT), entry.path).toContain(entry.appliesWhen)
			expect(entry.appliesWhen).toBe(appliesWhenFor(entry.path))
		}
	})

	it('writes each default as a value the control can hold', () => {
		for (const entry of SETTING_DESCRIPTORS) {
			const values = [entry.default, ...(entry.defaultWhen ?? []).map((rule) => rule.value)].filter(
				(value) => value !== undefined,
			)
			for (const value of values) {
				switch (entry.control.kind) {
					case 'toggle':
						expect(typeof value, entry.path).toBe('boolean')
						break
					case 'number':
						expect(typeof value, entry.path).toBe('number')
						if (typeof value === 'number') {
							if (entry.control.min !== undefined)
								expect(value, entry.path).toBeGreaterThanOrEqual(entry.control.min)
							if (entry.control.max !== undefined)
								expect(value, entry.path).toBeLessThanOrEqual(entry.control.max)
						}
						break
					case 'select':
						expect(optionValues(entry), entry.path).toContain(value)
						break
					case 'checks':
						expect(Array.isArray(value), entry.path).toBe(true)
						for (const item of value as string[])
							expect(optionValues(entry), entry.path).toContain(item)
						break
					case 'text':
						expect(typeof value, entry.path).toBe('string')
						break
					default:
						break
				}
			}
			if (entry.control.kind === 'file-only') expect(entry.default, entry.path).toBeUndefined()
		}
	})

	it('shows the real default of the switches whose default is on', () => {
		const byPath = new Map(SETTING_DESCRIPTORS.map((entry) => [entry.path, entry]))
		for (const path of [
			'updates.auto',
			'updates.check',
			'learningGenerator.enabled',
			'plugins.autoDiscovery',
		])
			expect(byPath.get(path)?.default, path).toBe(true)
		expect(byPath.get('composerTriggers.languages')?.default).toEqual(['en', 'tr'])
		expect(byPath.get('plugins.allowedScopes')?.default).toEqual(['project', 'user'])
		expect(byPath.get('plugins.hookTimeoutMs')?.default).toBe(600000)
		expect(byPath.get('sandbox.enabled')?.defaultWhen?.length).toBeGreaterThan(0)
	})

	it('gives every choice a plain label that differs from the saved value, and one line of help', () => {
		for (const entry of SETTING_DESCRIPTORS) {
			if (entry.control.kind !== 'select') continue
			for (const option of entry.control.options) {
				expect(option.help?.trim(), `${entry.path}=${option.value}`).toBeTruthy()
				expect(option.help).not.toContain('\n')
				if (!/^(on|off|json|yaml|exa|auto)$/i.test(option.value))
					expect(option.label, `${entry.path}=${option.value}`).not.toBe(option.value)
			}
		}
	})

	it('says terminal-only settings are for the terminal app', () => {
		const byPath = new Map(SETTING_DESCRIPTORS.map((entry) => [entry.path, entry]))
		for (const path of ['tui.sound', 'skills.suggest', 'skills.suggestMinToolCalls'])
			expect(`${byPath.get(path)?.label} ${byPath.get(path)?.description}`, path).toMatch(
				/terminal app/i,
			)
	})

	it('still sends the words an older Desktop reads, from the typed default', () => {
		const byPath = new Map(SETTING_DESCRIPTORS.map((entry) => [entry.path, entry]))
		const text = (path: string) =>
			withDefaultText(byPath.get(path) as SettingDescriptor).defaultText
		expect(text('updates.auto')).toMatch(/^on\. Off in automated runs/)
		expect(text('learningGenerator.enabled')).toBe('on')
		expect(text('composerTriggers.languages')).toBe('English, Turkish')
		expect(text('permissions.defaultMode')).toBe('Ask before risky actions')
		expect(text('sandbox.enabled')).toMatch(/^off\./)
		// Words written by hand are left alone.
		expect(text('limits.maxIterations')).toBe('no limit')
	})
})
