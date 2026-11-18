import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getBuiltinTools } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as yamlParse } from 'yaml'

import { builtinCommandArguments } from '@namzu/sdk'
import { checkSetting, readSettings, writeSetting } from './desktop-settings.js'
import { readConfigKey } from './load.js'
import { describeSetting, findSetting, parseSettingText, planSettingChange } from './setting-cli.js'
import {
	checkInputFromText,
	checkInputText,
	needsConfirmation,
	permissionChecksConfirmation,
	permissionChecksRemoved,
	permissionRuleRows,
	permissionRulesConfirmation,
	permissionRulesLoosened,
	permissionRulesTable,
	siteRows,
	sitesConfirmation,
	sitesLoosened,
	sitesValue,
} from './setting-values.js'
import { userConfigPath } from './user-config.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-permission-settings-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
const opts = () => ({ home, env: {} })
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

const MODES = `permissions:
  defaultMode: auto
  disableBypassMode: true
  disableAutoMode: false
  outsideRoot: refuse
  autoMode:
    model: smallModel
    hardDeny:
      - $defaults
      - Deleting a production database
`
const MODE_VALUES = {
	defaultMode: 'auto',
	disableBypassMode: true,
	disableAutoMode: false,
	outsideRoot: 'refuse',
	autoMode: { model: 'smallModel', hardDeny: ['$defaults', 'Deleting a production database'] },
}
const modeKeysOf = (permissions: unknown): Record<string, unknown> => {
	const { defaultMode, disableBypassMode, disableAutoMode, outsideRoot, autoMode } =
		permissions as Record<string, unknown>
	return { defaultMode, disableBypassMode, disableAutoMode, outsideRoot, autoMode }
}

describe('descriptor examples are values the loader accepts', () => {
	it('permission rules', () => {
		const control = entry('permissions').control
		if (control.kind !== 'permission-rules') throw new Error('kind')
		expect(() =>
			checkSetting({ path: 'permissions', value: JSON.parse(control.example) }, opts()),
		).not.toThrow()
	})
	it('permission self-checks, with an input that is an object', () => {
		const control = entry('permissionChecks').control
		if (control.kind !== 'permission-checks') throw new Error('kind')
		const example = JSON.parse(control.example)
		expect(typeof example[0].input).toBe('object')
		expect(() => checkSetting({ path: 'permissionChecks', value: example }, opts())).not.toThrow()
		expect(() => readConfigKey('permissionChecks', example, 'x.yaml')).not.toThrow()
	})
	it('browser sites, with a site the loader can read', () => {
		const control = entry('browser.sites').control
		if (control.kind !== 'sites') throw new Error('kind')
		const example = JSON.parse(control.example)
		expect(() => checkSetting({ path: 'browser.sites', value: example }, opts())).not.toThrow()
		expect(() => readConfigKey('browser', { sites: example }, 'x.yaml')).not.toThrow()
	})
	it("the shell tools named for the command box are the engine's own", () => {
		const control = entry('permissionChecks').control
		if (control.kind !== 'permission-checks') throw new Error('kind')
		const engine = builtinCommandArguments()
		expect([...engine.keys()].sort()).toEqual([...control.commandTools].sort())
		for (const tool of control.commandTools) expect(engine.get(tool)).toBe(control.commandField)
		expect(getBuiltinTools().length).toBeGreaterThan(0)
	})
})

describe('permission rules: rows and the table they save', () => {
	it('reads every spelling of a rule and leaves the mode keys out', () => {
		const rows = permissionRuleRows({
			defaultMode: 'auto',
			autoMode: { model: 'x' },
			bash: { 'git status *': 'allow', '*': 'ask' },
			read: 'allow',
			sources: { 'plugin:*': 'deny' },
		})
		expect(rows).toEqual([
			{ tool: 'bash', pattern: 'git status *', effect: 'allow' },
			{ tool: 'bash', pattern: '*', effect: 'ask' },
			{ tool: 'read', pattern: '', effect: 'allow' },
			{ tool: 'sources', pattern: 'plugin:*', effect: 'deny' },
		])
	})

	it('saves a whole tool as a word and a tool with patterns as a table', () => {
		expect(
			permissionRulesTable([
				{ tool: 'read', pattern: '', effect: 'allow' },
				{ tool: 'bash', pattern: 'git status *', effect: 'allow' },
				{ tool: 'bash', pattern: '', effect: 'ask' },
			]),
		).toEqual({ value: { read: 'allow', bash: { 'git status *': 'allow', '*': 'ask' } } })
	})

	it('refuses an empty tool, a tool with a space, a mode key, a bare sources and a rule listed twice', () => {
		expect(permissionRulesTable([{ tool: ' ', pattern: '', effect: 'ask' }])).toEqual({
			error: 'Enter a tool for each rule, such as bash.',
		})
		expect(permissionRulesTable([{ tool: 'my tool', pattern: '', effect: 'ask' }])).toEqual({
			error: '"my tool" is not a tool name: a tool is one word, such as bash.',
		})
		expect(permissionRulesTable([{ tool: 'defaultMode', pattern: '', effect: 'ask' }])).toEqual({
			error: 'defaultMode is a permission setting with a row of its own, not a tool.',
		})
		expect(permissionRulesTable([{ tool: 'sources', pattern: '', effect: 'deny' }])).toEqual({
			error: 'A sources rule needs a source, such as an id or a pattern of ids.',
		})
		expect(
			permissionRulesTable([
				{ tool: 'bash', pattern: 'ls', effect: 'allow' },
				{ tool: 'bash', pattern: 'ls', effect: 'deny' },
			]),
		).toEqual({ error: 'bash "ls" is listed twice.' })
		expect(
			permissionRulesTable([
				{ tool: 'bash', pattern: '', effect: 'allow' },
				{ tool: 'bash', pattern: '*', effect: 'deny' },
			]),
		).toEqual({ error: 'bash "*" is listed twice.' })
		expect(permissionRulesTable([{ tool: 'bash', pattern: '', effect: 'maybe' }])).toEqual({
			error: 'Choose allow, ask or deny for bash.',
		})
	})
})

describe('permission rules: what lets more run asks, what restricts does not', () => {
	const base = { bash: { 'git status *': 'allow', 'rm *': 'deny' }, edit: 'ask', read: 'allow' }
	it('asks for an added allow rule and names it', () => {
		const next = { ...base, write: 'allow', web_fetch: { '*://a.dev/*': 'allow' } }
		expect(permissionRulesLoosened(base, next).map((c) => [c.kind, c.tool, c.pattern])).toEqual([
			['added', 'write', ''],
			['added', 'web_fetch', '*://a.dev/*'],
		])
		expect(
			permissionRulesConfirmation('Rules can let tools run without asking you.', base, next),
		).toBe(
			'Rules can let tools run without asking you. write (every call) is allowed without asking. web_fetch "*://a.dev/*" is allowed without asking.',
		)
	})
	it('asks when a rule becomes more permissive, deny to ask included', () => {
		const next = { ...base, edit: 'allow', bash: { 'git status *': 'allow', 'rm *': 'ask' } }
		expect(permissionRulesConfirmation('S.', base, next)).toBe(
			'S. bash "rm *" goes from deny to ask. edit (every call) goes from ask to allow.',
		)
	})
	it('asks when a deny or an ask rule is removed, and when Use default clears them', () => {
		const next = { bash: { 'git status *': 'allow' }, read: 'allow' }
		expect(permissionRulesConfirmation('S.', base, next)).toBe(
			'S. The deny rule for bash "rm *" is removed. The ask rule for edit (every call) is removed.',
		)
		expect(permissionRulesLoosened(base, undefined)).toHaveLength(2)
	})
	it('never asks for a change that only restricts', () => {
		const next = {
			bash: { 'git status *': 'ask', 'rm *': 'deny', 'curl *': 'deny' },
			edit: 'deny',
			write: 'ask',
		}
		expect(permissionRulesLoosened(base, next)).toEqual([])
		// Removing an allow rule restricts too.
		expect(permissionRulesLoosened({ read: 'allow' }, undefined)).toEqual([])
		expect(permissionRulesLoosened({ read: 'allow' }, {})).toEqual([])
	})
	it('is what needsConfirmation says for the setting', () => {
		const e = entry('permissions')
		expect(needsConfirmation(e, { ...base, write: 'allow' }, base)).toBe(true)
		expect(needsConfirmation(e, { ...base, write: 'deny' }, base)).toBe(false)
		expect(needsConfirmation(e, undefined, base)).toBe(true)
		expect(needsConfirmation(e, undefined, { read: 'allow' })).toBe(false)
	})
})

describe('permission rules: the mode keys survive every edit', () => {
	it('is read as the rules alone, with the mode keys and list spelling folded', () => {
		seed(
			`${MODES.replace('permissions:\n', 'permissions:\n  allow:\n    - Read\n    - Bash(git status:*)\n  deny:\n    - Bash(rm -rf *)\n  edit: ask\n')}`,
		)
		const row = readSettings(opts()).settings.find((s) => s.path === 'permissions')
		expect(row?.set).toBe(true)
		expect(row?.value).toEqual({
			edit: 'ask',
			read: 'allow',
			bash: { 'git status *': 'allow', 'rm -rf *': 'deny' },
		})
	})

	it('adding, changing and removing rules leave every mode key as written', () => {
		seed(`${MODES}  bash:\n    ls: allow\n  edit: ask\n`)
		const rules = [
			{ bash: { ls: 'allow', 'git status *': 'allow' }, edit: 'ask' },
			{ bash: { ls: 'ask' }, edit: 'deny', read: 'allow' },
			{ edit: 'deny' },
		]
		for (const value of rules) {
			writeSetting({ path: 'permissions', value }, opts())
			const after = saved().permissions as Record<string, unknown>
			expect(modeKeysOf(after)).toEqual(MODE_VALUES)
			const { defaultMode, disableBypassMode, disableAutoMode, outsideRoot, autoMode, ...tools } =
				after
			void [defaultMode, disableBypassMode, disableAutoMode, outsideRoot, autoMode]
			expect(tools).toEqual(value)
		}
	})

	it('Use default clears only the rules', () => {
		seed(`${MODES}  bash:\n    ls: allow\n  edit: ask\n`)
		writeSetting({ path: 'permissions' }, opts())
		expect(saved().permissions).toEqual(MODE_VALUES)
		// And through the terminal's plan, the same.
		seed(`${MODES}  edit: ask\n`)
		const plan = planSettingChange('permissions', undefined, opts())
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.confirm).toContain('The ask rule for edit (every call) is removed.')
		plan.apply()
		expect(saved().permissions).toEqual(MODE_VALUES)
	})

	it('a file with no mode keys loses the permissions key when the last rule goes', () => {
		seed('permissions:\n  edit: ask\nmodel: auto\nrouting:\n  default: {provider: a, model: b}\n')
		writeSetting({ path: 'permissions' }, opts())
		expect(saved().permissions).toBeUndefined()
		expect(saved().model).toBe('auto')
	})

	it('writes the rules in the table shape and folds the list spelling away', () => {
		seed(`${MODES}  allow:\n    - Read\n  deny:\n    - Bash(rm *)\n`)
		const rules = readSettings(opts()).settings.find((s) => s.path === 'permissions')?.value
		writeSetting({ path: 'permissions', value: { ...(rules as object), edit: 'ask' } }, opts())
		const after = saved().permissions as Record<string, unknown>
		expect(after.allow).toBeUndefined()
		expect(after.deny).toBeUndefined()
		expect(after.read).toBe('allow')
		expect(after.bash).toEqual({ 'rm *': 'deny' })
		expect(after.edit).toBe('ask')
		expect(modeKeysOf(after)).toEqual(MODE_VALUES)
	})

	it('refuses a table that carries a mode key, and says where it lives', () => {
		seed(MODES)
		for (const key of [
			'defaultMode',
			'disableBypassMode',
			'disableAutoMode',
			'outsideRoot',
			'autoMode',
		])
			expect(() => writeSetting({ path: 'permissions', value: { [key]: 'x' } }, opts())).toThrow(
				`${key} is a permission setting with a row of its own; this one holds only the tool rules.`,
			)
		expect(modeKeysOf(saved().permissions)).toEqual(MODE_VALUES)
	})

	it("refuses what the engine's compiler refuses, in its words", () => {
		expect(() => writeSetting({ path: 'permissions', value: { bash: 'maybe' } }, opts())).toThrow(
			'bash (every call): expected "allow", "ask", "deny", or a table of patterns; got string',
		)
		expect(() =>
			writeSetting({ path: 'permissions', value: { bash: { ls: 'sometimes' } } }, opts()),
		).toThrow('bash "ls": expected "allow", "ask" or "deny"; got "sometimes"')
		expect(() =>
			writeSetting({ path: 'permissions', value: { allow: ['Bash(unbalanced'] } }, opts()),
		).toThrow('is not a rule')
	})
})

describe('permission rules in the terminal', () => {
	it('takes JSON, asks about an allow and says the sentence', () => {
		seed(MODES)
		const parsed = parseSettingText(
			entry('permissions'),
			'{"bash":{"git status *":"allow"}}',
			opts(),
		)
		expect(parsed).toEqual({ value: { bash: { 'git status *': 'allow' } } })
		const plan = planSettingChange('permissions', '{"bash":{"git status *":"allow"}}', opts())
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.confirm).toBe(
			'Rules can let tools run without asking you. bash "git status *" is allowed without asking.',
		)
		plan.apply()
		expect(modeKeysOf(saved().permissions)).toEqual(MODE_VALUES)
	})
	it('does not ask for a rule that only restricts', () => {
		const plan = planSettingChange('permissions', '{"bash":"deny"}', opts())
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.confirm).toBeUndefined()
	})
	it('says the rules in words on get, without the mode keys', () => {
		seed(`${MODES}  bash:\n    ls: allow\n`)
		const text = describeSetting('permissions', opts())
		expect(text).toContain('bash "ls" allow')
		expect(text).not.toContain('defaultMode')
	})
})

describe('permission self-checks', () => {
	const checks = [
		{ tool: 'bash', input: { command: 'rm -rf /' }, expect: 'deny' },
		{ tool: 'read', input: { path: 'a.txt' }, expect: 'allow' },
	]
	it('writes tool, input and answer exactly as the loader reads them', () => {
		writeSetting({ path: 'permissionChecks', value: checks }, opts())
		expect(saved().permissionChecks).toEqual(checks)
	})
	it('drops fields the loader does not read and trims the tool', () => {
		writeSetting(
			{
				path: 'permissionChecks',
				value: [{ tool: ' bash ', input: { command: 'ls' }, expect: 'ask', note: 'x' }],
			},
			opts(),
		)
		expect(saved().permissionChecks).toEqual([
			{ tool: 'bash', input: { command: 'ls' }, expect: 'ask' },
		])
	})
	it("refuses a bad entry with the loader's words, naming its place", () => {
		const bad = (value: unknown) => () => writeSetting({ path: 'permissionChecks', value }, opts())
		expect(bad([{ tool: 'bash', input: 'rm -rf /', expect: 'deny' }])).toThrow(
			'permissionChecks[0]: expected an "input" object for bash; got string',
		)
		expect(bad([checks[0], { tool: '', input: {}, expect: 'deny' }])).toThrow(
			'permissionChecks[1]: expected a "tool" naming the tool to evaluate',
		)
		expect(bad([{ tool: 'bash', input: {}, expect: 'maybe' }])).toThrow(
			'permissionChecks[0]: expected "expect" to be "allow", "ask" or "deny"; got "maybe"',
		)
		expect(bad({ tool: 'bash' })).toThrow('permissionChecks must be a list.')
	})
	it('an empty list removes the key', () => {
		seed('permissionChecks:\n  - {tool: bash, input: {command: ls}, expect: ask}\n')
		writeSetting({ path: 'permissionChecks', value: [] }, opts())
		expect(saved().permissionChecks).toBeUndefined()
	})
	it('builds the input object from a command box, or from JSON', () => {
		const tools = ['bash']
		expect(checkInputFromText('bash', 'git status', tools, 'command')).toEqual({
			value: { command: 'git status' },
		})
		expect(checkInputFromText('bash', '  ', tools, 'command')).toEqual({
			error: 'Enter the command the check runs.',
		})
		expect(checkInputFromText('read', '{"path":"a"}', tools, 'command')).toEqual({
			value: { path: 'a' },
		})
		expect(checkInputFromText('read', '"a"', tools, 'command')).toEqual({
			error: 'The input is an object, such as {"path":"a.txt"}.',
		})
		expect('error' in checkInputFromText('read', '{oops', tools, 'command')).toBe(true)
		expect(checkInputText({ tool: 'bash', input: { command: 'ls' } }, tools, 'command')).toBe('ls')
		expect(checkInputText({ tool: 'read', input: { path: 'a' } }, tools, 'command')).toBe(
			'{"path":"a"}',
		)
	})
	it('asks when a check is removed or changed, never when one is added', () => {
		expect(
			permissionChecksRemoved(checks, [...checks, { tool: 'edit', input: {}, expect: 'ask' }]),
		).toEqual([])
		const changed = [{ ...checks[0], expect: 'ask' }, checks[1]]
		expect(permissionChecksConfirmation('S.', checks, changed)).toBe(
			'S. Removed or changed: bash {"command":"rm -rf /"} must be deny.',
		)
		expect(needsConfirmation(entry('permissionChecks'), undefined, checks)).toBe(true)
		expect(needsConfirmation(entry('permissionChecks'), checks, checks)).toBe(false)
		expect(needsConfirmation(entry('permissionChecks'), [], checks)).toBe(true)
	})
	it('says the checks in words on get', () => {
		seed('permissionChecks:\n  - {tool: bash, input: {command: ls}, expect: ask}\n')
		expect(describeSetting('permissionChecks', opts())).toContain(
			'bash {"command":"ls"} must be ask',
		)
	})
})

describe('browser sites', () => {
	it('is read as lines and the line for every other site', () => {
		expect(siteRows({ 'https://a.dev': 'read', '*': 'deny', 'https://b.dev': 'act' })).toEqual({
			sites: [
				{ site: 'https://a.dev', level: 'read' },
				{ site: 'https://b.dev', level: 'act' },
			],
			other: 'deny',
		})
		expect(siteRows(undefined)).toEqual({ sites: [], other: '' })
	})
	it('saves the map with every other site last, and leaves it out at the default', () => {
		expect(sitesValue([{ site: 'https://a.dev', level: 'read' }], 'deny')).toEqual({
			value: { 'https://a.dev': 'read', '*': 'deny' },
		})
		expect(sitesValue([{ site: 'https://a.dev', level: 'read' }], '')).toEqual({
			value: { 'https://a.dev': 'read' },
		})
		expect(sitesValue([{ site: ' ', level: 'read' }], '')).toEqual({
			error: 'Enter a site for each line, such as https://example.com.',
		})
		expect(
			sitesValue(
				[
					{ site: 'https://a.dev', level: 'read' },
					{ site: 'https://a.dev', level: 'deny' },
				],
				'',
			),
		).toEqual({ error: 'https://a.dev is listed twice.' })
	})
	it("writes the same map, with the loader's keys, and refuses what the loader refuses", () => {
		writeSetting(
			{
				path: 'browser.sites',
				value: { '*': 'ask', 'https://*.example.com': 'read', 'http://localhost:*': 'act' },
			},
			opts(),
		)
		expect(saved().browser).toEqual({
			sites: { 'https://*.example.com': 'read', 'http://localhost:*': 'act', '*': 'ask' },
		})
		const bad = (value: unknown) => () => writeSetting({ path: 'browser.sites', value }, opts())
		expect(bad({ 'example.com': 'read' })).toThrow(
			'example.com: "example.com" is not a site; write scheme://host, optionally *.host and :port or :*, with no path',
		)
		expect(bad({ 'https://a.dev': 'allow' })).toThrow(
			'https://a.dev: must be deny, read, ask or act',
		)
		expect(bad({ 'ftp://a.dev': 'read' })).toThrow('the scheme "ftp:" is not allowed')
		expect(bad({ 'https://a.dev': 'read', ' https://a.dev ': 'deny' })).toThrow('is listed twice.')
	})
	it('keeps the other browser keys when sites change, and removing the last line removes the key', () => {
		seed('browser:\n  enabled: true\n  sites:\n    "https://a.dev": read\n')
		writeSetting({ path: 'browser.sites', value: { 'https://b.dev': 'deny' } }, opts())
		expect(saved().browser).toEqual({ enabled: true, sites: { 'https://b.dev': 'deny' } })
		writeSetting({ path: 'browser.sites' }, opts())
		expect(saved().browser).toEqual({ enabled: true })
	})
	it('asks when a site becomes act, naming it, and for every other site', () => {
		const before = { 'https://a.dev': 'read' }
		expect(sitesConfirmation('S.', before, { ...before, 'https://b.dev': 'act' })).toBe(
			'S. Namzu may click and type on https://b.dev.',
		)
		expect(sitesConfirmation('S.', before, { ...before, '*': 'act' })).toBe(
			'S. Namzu may click and type on every other site.',
		)
		expect(sitesLoosened(before, { 'https://a.dev': 'act' })).toEqual([
			{ site: 'https://a.dev', was: 'read', now: 'act' },
		])
	})
	it('never asks for deny or read, or for a site that stays act', () => {
		const before = { 'https://a.dev': 'act', '*': 'ask' }
		expect(sitesLoosened(before, { ...before, 'https://b.dev': 'deny' })).toEqual([])
		expect(sitesLoosened(before, { ...before, 'https://b.dev': 'read' })).toEqual([])
		expect(sitesLoosened(before, { ...before, 'https://b.dev': 'ask' })).toEqual([])
		expect(sitesLoosened(before, { 'https://a.dev': 'act' })).toEqual([])
		expect(sitesLoosened(before, { 'https://a.dev': 'deny', '*': 'deny' })).toEqual([])
	})
	it('asks when a deny line is removed or changed and the site is then open, not when it stays denied', () => {
		const before = { 'https://a.dev': 'deny', '*': 'ask' }
		expect(sitesConfirmation('S.', before, { '*': 'ask' })).toBe(
			'S. https://a.dev is no longer denied; it is now ask.',
		)
		expect(sitesLoosened(before, { 'https://a.dev': 'read', '*': 'ask' })).toHaveLength(1)
		// Removed while every other site is denied: still denied, so nothing widens.
		expect(sitesLoosened({ 'https://a.dev': 'deny', '*': 'deny' }, { '*': 'deny' })).toEqual([])
		// Every other site stops being denied.
		expect(sitesLoosened({ '*': 'deny' }, {})).toEqual([{ site: '*', was: 'deny', now: 'ask' }])
		// Clearing a map of reads and asks does not ask.
		expect(sitesLoosened({ 'https://a.dev': 'read' }, undefined)).toEqual([])
	})
	it('is what needsConfirmation says, and the terminal prints the sentence', () => {
		seed('browser:\n  sites:\n    "https://a.dev": deny\n')
		expect(
			needsConfirmation(
				entry('browser.sites'),
				{ 'https://a.dev': 'read' },
				{ 'https://a.dev': 'deny' },
			),
		).toBe(true)
		const plan = planSettingChange('browser.sites', '{"https://a.dev":"act"}', opts())
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.confirm).toBe(
			'Allowing act lets Namzu click and type on that site. Namzu may click and type on https://a.dev.',
		)
		const quiet = planSettingChange(
			'browser.sites',
			'{"https://a.dev":"deny","https://b.dev":"read"}',
			opts(),
		)
		if (!quiet.ok) throw new Error(quiet.error)
		expect(quiet.confirm).toBeUndefined()
	})
	it('says the lines in words on get, with the default for every other site', () => {
		seed('browser:\n  sites:\n    "https://a.dev": read\n')
		expect(describeSetting('browser.sites', opts())).toContain(
			'https://a.dev Read; every other site Ask',
		)
	})
})
