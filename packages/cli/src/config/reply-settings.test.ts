import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { fastLaunchRefusal } from '../tui/fast-mode.js'
import { ConfigValueError, loadConfig } from './load.js'
import { sessionOptionsFromConfig } from './session-options.js'
import { SETTING_DESCRIPTORS, appliesTextFor } from './settings-descriptors.js'

function load(user?: string, project?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	if (project !== undefined) writeFileSync(join(cwd, 'namzu.config.json'), project)
	return loadConfig({ home, cwd, env: {}, managedPath: join(cwd, 'managed.json') })
}

const row = (path: string) => SETTING_DESCRIPTORS.find((d) => d.path === path)

describe('workflow.enabled', () => {
	it('is absent by default, which means the tool is offered', () => {
		expect(load().workflow?.enabled).toBeUndefined()
	})

	it('reads true and false next to the caps, and refuses anything else', () => {
		expect(load('workflow:\n  enabled: false\n  maxAgents: 5\n').workflow).toEqual({
			enabled: false,
			maxAgents: 5,
		})
		expect(() => load('workflow:\n  enabled: maybe\n')).toThrow(ConfigValueError)
	})

	it('is a described switch, on by default, that says it uses the limit faster', () => {
		expect(row('workflow.enabled')?.default).toBe(true)
		expect(row('workflow.enabled')?.group).toBe('helpers-workflows')
		expect(row('workflow.enabled')?.description).toMatch(/Uses your limit faster/u)
		expect(row('workflow.enabled')?.appliesWhen).toBe('next-conversation')
	})
})

describe('closingSummary', () => {
	it('reads true and false, refuses anything else, and reaches the session only when false', () => {
		expect(load().closingSummary).toBeUndefined()
		expect(load('closingSummary: false\n').closingSummary).toBe(false)
		expect(() => load('closingSummary: 1\n')).toThrow(ConfigValueError)
		const options = (config: Parameters<typeof sessionOptionsFromConfig>[0]) =>
			sessionOptionsFromConfig(config, { cwd: '/tmp' })
		expect(options(load('closingSummary: false\n'))).toMatchObject({ closingSummary: false })
		expect(options(load('closingSummary: true\n'))).not.toHaveProperty('closingSummary')
		expect(options(load())).not.toHaveProperty('closingSummary')
	})

	it('is a described switch, on by default, for new conversations', () => {
		expect(row('closingSummary')?.default).toBe(true)
		expect(row('closingSummary')?.appliesWhen).toBe('next-conversation')
	})
})

describe('effort', () => {
	it('reads one level the flag accepts and refuses any other word', () => {
		expect(load().effort).toBeUndefined()
		expect(load('effort: high\n').effort).toBe('high')
		expect(() => load('effort: turbo\n')).toThrow(ConfigValueError)
		expect(() => load('effort: auto\n')).toThrow(/model's own default/u)
	})

	it('reaches the session as the saved default', () => {
		expect(sessionOptionsFromConfig(load('effort: low\n'), { cwd: '/tmp' })).toMatchObject({
			savedEffort: 'low',
		})
		expect(sessionOptionsFromConfig(load(), { cwd: '/tmp' })).not.toHaveProperty('savedEffort')
	})

	it("has a choice for every level the flag accepts and no default but the model's own", () => {
		const entry = row('effort')
		expect(entry?.control.kind).toBe('select')
		const values = entry?.control.kind === 'select' ? entry.control.options.map((o) => o.value) : []
		expect(values).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
		expect(entry?.default).toBeUndefined()
		expect(entry?.defaultText).toBe("the model's own default")
	})
})

describe('fast', () => {
	it('reads true and false and refuses anything else', () => {
		expect(load().fast).toBeUndefined()
		expect(load('fast: true\n').fast).toBe(true)
		expect(() => load('fast: quick\n')).toThrow(ConfigValueError)
	})

	it('is off by default, asks before it is turned on, and applies when the terminal app starts', () => {
		const entry = row('fast')
		expect(entry?.default).toBe(false)
		expect(entry?.confirmWhen).toBe('on')
		expect(entry?.description).toMatch(/twice the standard rate/u)
		expect(entry && appliesTextFor(entry)).toBe('Applies the next time the terminal app starts.')
	})

	it('names a saved setting, not the flag, when the model cannot take it', () => {
		expect(fastLaunchRefusal('No.', 'saved')).toBe(
			'The saved fast mode setting was not applied: No. Continuing at standard speed.',
		)
		expect(fastLaunchRefusal('No.')).toMatch(/^--fast was not applied/u)
	})
})

describe('respectGitignore', () => {
	it('reads true and false and refuses anything else', () => {
		expect(load().respectGitignore).toBeUndefined()
		expect(load('respectGitignore: false\n').respectGitignore).toBe(false)
		expect(() => load('respectGitignore: 0\n')).toThrow(ConfigValueError)
	})

	it('is on by default and asks before it is turned off', () => {
		const entry = row('respectGitignore')
		expect(entry?.default).toBe(true)
		expect(entry?.group).toBe('folders')
		expect(entry?.confirmWhen).toBe('off')
	})
})

describe('what a repository may not decide', () => {
	it('drops effort, fast and respectGitignore from the project file, which cost money or show files', () => {
		const config = load(
			'effort: low\n',
			JSON.stringify({ effort: 'max', fast: true, respectGitignore: false }),
		)
		expect(config.effort).toBe('low')
		expect(config.fast).toBeUndefined()
		expect(config.respectGitignore).toBeUndefined()
	})
})
