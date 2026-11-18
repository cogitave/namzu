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
	SETTING_SUBKEY_EXCLUSIONS,
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

/**
 * Every leaf path of `NamzuCliConfig` (`limits.tokenBudget`, `tui.mouse`, ...), from the type checker.
 * A property whose type is a plain object with named properties is walked into; anything else (a
 * scalar, a union, an array, a map with an index signature) is a leaf. So a sub-key added to an
 * object that already has described siblings still has to be described or excluded on its own.
 */
function namzuCliConfigLeafPaths(): string[] {
	const file = join(here, 'schema.ts')
	const program = ts.createProgram([file], {
		strict: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		skipLibCheck: true,
		noEmit: true,
	})
	const checker = program.getTypeChecker()
	const source = program.getSourceFile(file)
	let root: ts.Type | undefined
	source?.forEachChild((node) => {
		if (ts.isInterfaceDeclaration(node) && node.name.text === 'NamzuCliConfig')
			root = checker.getTypeAtLocation(node)
	})
	if (!root) throw new Error('NamzuCliConfig not found in schema.ts')
	const isPlainObject = (type: ts.Type): boolean => {
		const bare = checker.getNonNullableType(type)
		if (bare.isUnion() || checker.isArrayType(bare) || checker.isTupleType(bare)) return false
		if (!(bare.flags & ts.TypeFlags.Object)) return false
		if (checker.getIndexInfosOfType(bare).length > 0) return false
		if (bare.getCallSignatures().length > 0) return false
		return bare.getProperties().length > 0
	}
	const leaves: string[] = []
	const walk = (type: ts.Type, prefix: string, depth: number): void => {
		for (const property of checker.getPropertiesOfType(type)) {
			const path = prefix ? `${prefix}.${property.name}` : property.name
			const propertyType = checker.getTypeOfSymbol(property)
			if (depth < 4 && isPlainObject(propertyType))
				walk(checker.getNonNullableType(propertyType), path, depth + 1)
			else leaves.push(path)
		}
	}
	walk(root, '', 0)
	return leaves
}

/** `key` names `path` itself or an object that contains it. */
const covers = (path: string, key: string): boolean => path === key || path.startsWith(`${key}.`)

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

	it('has a description or a stated exclusion for every nested key, not only the top-level one', () => {
		const leaves = namzuCliConfigLeafPaths()
		expect(leaves.length).toBeGreaterThan(100)
		const described = SETTING_DESCRIPTORS.map((entry) => entry.path)
		const excluded = [...SETTING_EXCLUSIONS, ...SETTING_SUBKEY_EXCLUSIONS].map((entry) => entry.key)
		// A leaf is covered by a description of it or of an object around it (`routing` edited whole),
		// by descriptions of its parts when its type is a union walked no further (`learningGenerator`,
		// a switch or an object), or by an exclusion of it or of an object around it.
		const missing = leaves.filter(
			(leaf) =>
				!described.some((path) => covers(leaf, path) || covers(path, leaf)) &&
				!excluded.some((key) => covers(leaf, key)),
		)
		expect(missing, `config keys with no description and no exclusion: ${missing}`).toEqual([])
		for (const entry of SETTING_SUBKEY_EXCLUSIONS)
			expect(
				leaves.some((leaf) => covers(leaf, entry.key)),
				`${entry.key} is excluded but is not a config key`,
			).toBe(true)
	})

	it('starts every row description with a capital letter, a digit or a quote', () => {
		for (const entry of SETTING_DESCRIPTORS)
			expect(entry.description, entry.path).toMatch(/^[\p{Lu}\p{N}"'“‘]/u)
	})

	it('names when every change applies, in a way a screen can say', () => {
		for (const entry of SETTING_DESCRIPTORS) {
			expect(Object.keys(APPLIES_WHEN_TEXT), entry.path).toContain(entry.appliesWhen)
		}
		const traced: Record<string, string> = {
			'updates.auto': 'next-start',
			'tui.sound': 'next-start',
			'limits.maxIterations': 'next-conversation',
			'limits.tokenBudget': 'next-conversation',
			'limits.maxResponseTokens': 'next-conversation',
			'workflow.maxAgents': 'next-conversation',
			'compaction.strategy': 'next-conversation',
			'permissions.defaultMode': 'next-conversation',
			hypermode: 'next-conversation',
			disableHooks: 'next-conversation',
			smallModel: 'next-conversation',
			// Read once when the process or the host starts.
			'permissions.autoMode': 'next-start',
			'permissions.disableBypassMode': 'next-start',
			'plugins.enabled': 'next-start',
			'telemetry.otlp.endpoint': 'next-start',
			modelCatalogueRefresh: 'next-start',
			routing: 'next-start',
			format: 'next-start',
			model: 'next-start',
			'handBack.enabled': 'next-conversation',
			'skills.builtin': 'next-conversation',
			'compaction.recallEvidence': 'next-conversation',
		}
		for (const [path, when] of Object.entries(traced)) expect(appliesWhenFor(path), path).toBe(when)
		const byPath = new Map(SETTING_DESCRIPTORS.map((entry) => [entry.path, entry.appliesWhen]))
		for (const path of ['limits.maxIterations', 'handBack.enabled', 'skills.builtin'])
			if (byPath.has(path)) expect(byPath.get(path), path).toBe(traced[path])
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
