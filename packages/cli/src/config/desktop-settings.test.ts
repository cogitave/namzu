import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkSetting, describeChange, readSettings, writeSetting } from './desktop-settings.js'
import { CONFIG_KEYS } from './load.js'
import {
	SETTING_DESCRIPTORS,
	SETTING_EXCLUSIONS,
	SETTING_SUBKEY_EXCLUSIONS,
} from './settings-descriptors.js'
import { userConfigPath } from './user-config.js'

describe('Desktop settings descriptors', () => {
	it('cover every top-level config key or exclude it with a reason', () => {
		const described = new Set(SETTING_DESCRIPTORS.map((entry) => entry.path.split('.')[0]))
		const excluded = new Map(SETTING_EXCLUSIONS.map((entry) => [entry.key, entry.reason]))
		const missing = CONFIG_KEYS.filter((key) => !described.has(key) && !excluded.has(key))
		expect(missing).toEqual([])
		for (const reason of excluded.values()) expect(reason.length).toBeGreaterThan(10)
		for (const key of excluded.keys()) expect(described.has(key)).toBe(false)
	})

	it('describe only keys the loader reads, once each', () => {
		const paths = SETTING_DESCRIPTORS.map((entry) => entry.path)
		expect(new Set(paths).size).toBe(paths.length)
		for (const path of paths) expect(CONFIG_KEYS).toContain(path.split('.')[0])
		for (const entry of SETTING_SUBKEY_EXCLUSIONS) expect(paths).not.toContain(entry.key)
	})

	it('give every setting a label and a one-line description', () => {
		for (const entry of SETTING_DESCRIPTORS) {
			expect(entry.label.trim()).not.toBe('')
			expect(entry.description.trim()).not.toBe('')
			expect(entry.description).not.toContain('\n')
		}
	})

	it('ask before the settings that widen what runs unasked', () => {
		for (const path of [
			'permissions',
			'permissions.defaultMode',
			'sandbox.enabled',
			'sandbox.allowEscape',
			'additionalDirectories',
			'plugins.enabled',
			'telemetry.sessionExport.destination',
		])
			expect(describeChange(path).confirm, path).toBeTruthy()
	})

	it('ask before every control that removes a check or a cap', () => {
		const expected: Record<string, string> = {
			'permissions.disableBypassMode': 'off',
			'permissions.disableAutoMode': 'off',
			'limits.doneGate': 'off',
			'limits.maxIterations': 'zero',
			'limits.tokenBudget': 'zero',
			'limits.costLimitUsd': 'zero',
			'sandbox.enabled': 'off',
			'web.fetch': 'on',
			hypermode: 'on',
		}
		for (const [path, when] of Object.entries(expected)) {
			const entry = SETTING_DESCRIPTORS.find((e) => e.path === path)
			expect(entry?.confirm, path).toBeTruthy()
			expect(entry?.confirmWhen, path).toBe(when)
		}
		expect(SETTING_DESCRIPTORS.find((e) => e.path === 'permissionChecks')?.confirm).toBeTruthy()
	})

	it('lists the outside-the-folder setting as a choice between ask and refuse', () => {
		const entry = SETTING_DESCRIPTORS.find((e) => e.path === 'permissions.outsideRoot')
		expect(entry?.control).toMatchObject({ kind: 'select' })
		expect(entry?.default).toBe('ask')
		expect(entry?.confirm).toBeTruthy()
		expect(entry?.confirmValue).toBe('ask')
	})

	it('keep command-line-only keys in the terminal section, and the update checks in Updates', () => {
		for (const path of ['format', 'quiet', 'profiles'])
			expect(SETTING_DESCRIPTORS.find((e) => e.path === path)?.section, path).toBe('terminal')
		for (const path of ['updates.channel', 'updates.auto', 'updates.check'])
			expect(SETTING_DESCRIPTORS.find((e) => e.path === path)?.section, path).toBe('updates')
	})

	it('never put a secret-bearing key behind an editable control', () => {
		for (const path of ['mcpServers', 'hooks', 'telemetry.otlp.headers', 'decision', 'statusLine'])
			expect(SETTING_DESCRIPTORS.find((entry) => entry.path === path)?.control.kind).toBe(
				'file-only',
			)
	})
})

describe('writing a Desktop setting', () => {
	let home: string
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'namzu-settings-'))
	})
	afterEach(() => rmSync(home, { recursive: true, force: true }))
	const opts = () => ({ home, env: {} as NodeJS.ProcessEnv })

	it('writes a valid value and reads it back', () => {
		writeSetting({ path: 'limits.maxIterations', value: 12 }, opts())
		writeSetting({ path: 'quiet', value: true }, opts())
		const state = readSettings(opts()).settings
		expect(state.find((s) => s.path === 'limits.maxIterations')).toEqual({
			path: 'limits.maxIterations',
			set: true,
			value: 12,
		})
		expect(state.find((s) => s.path === 'quiet')?.value).toBe(true)
		expect(state.find((s) => s.path === 'format')?.set).toBe(false)
	})

	it('refuses a value the loader would refuse, and leaves the file alone', () => {
		expect(() => writeSetting({ path: 'workflow.maxConcurrency', value: 99 }, opts())).toThrow(
			/16 or less/,
		)
		expect(() => writeSetting({ path: 'format', value: 'xml' }, opts())).toThrow(/Choose one of/)
		expect(() =>
			writeSetting({ path: 'permissions', value: '"allow everything"' }, opts()),
		).toThrow(/permissions/)
		expect(existsSync(userConfigPath(opts()))).toBe(false)
	})

	it('shows the loader sentence for a block it rejects', () => {
		expect(() => writeSetting({ path: 'routing', value: '"nonsense"' }, opts())).toThrow(/routing/)
		expect(() => writeSetting({ path: 'skills.disabled', value: '{bad' }, opts())).toThrow(
			/not valid JSON/,
		)
	})

	it('checks a change without writing it', () => {
		expect(() => checkSetting({ path: 'workflow.maxConcurrency', value: 99 }, opts())).toThrow(
			/16 or less/,
		)
		expect(() => checkSetting({ path: 'permissions', value: '{bad' }, opts())).toThrow(
			/not valid JSON/,
		)
		checkSetting({ path: 'limits.maxIterations', value: 5 }, opts())
		expect(existsSync(userConfigPath(opts()))).toBe(false)
	})

	it('refuses a path that is not described, and a file-only one', () => {
		expect(() => writeSetting({ path: 'nope', value: true }, opts())).toThrow(/not a setting/)
		expect(() => writeSetting({ path: 'mcpServers', value: '{}' }, opts())).toThrow(/config file/)
		expect(() => writeSetting({ path: 'mcpServers' }, opts())).toThrow(/config file/)
	})

	it('never reads a file-only setting back out', () => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(
			userConfigPath(opts()),
			'mcpServers:\n  a:\n    command: x\n    env:\n      TOKEN: hunter2\n',
			{ flag: 'w' },
		)
		const state = readSettings(opts()).settings.find((s) => s.path === 'mcpServers')
		expect(state).toEqual({ path: 'mcpServers', set: true })
		expect(JSON.stringify(readSettings(opts()))).not.toContain('hunter2')
	})

	it('clears a setting back to its default and keeps the rest of the file', () => {
		writeSetting({ path: 'limits.maxIterations', value: 3 }, opts())
		writeSetting({ path: 'limits.timeoutMs', value: 1000 }, opts())
		writeSetting({ path: 'limits.maxIterations' }, opts())
		const text = readFileSync(userConfigPath(opts()), 'utf8')
		expect(text).toContain('timeoutMs')
		expect(text).not.toContain('maxIterations')
	})

	it('refuses to rewrite a file that is not valid YAML', () => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(userConfigPath(opts()), 'a: [unclosed\n')
		expect(() => writeSetting({ path: 'quiet', value: true }, opts())).toThrow()
	})

	it('names the file, the line and the column of a file that is not valid YAML', () => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(userConfigPath(opts()), 'limits: [unclosed\n  : : bad\n')
		expect(() => writeSetting({ path: 'quiet', value: true }, opts())).toThrow(
			/config\.yaml isn't valid YAML \(line 2, column 5\)\.$/,
		)
	})
})

describe('settings that depend on other settings', () => {
	let home: string
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'namzu-settings-cross-'))
	})
	afterEach(() => rmSync(home, { recursive: true, force: true }))
	const opts = () => ({ home, env: {} as NodeJS.ProcessEnv })
	const seed = (text: string) => {
		mkdirSync(dirname(userConfigPath(opts())), { recursive: true })
		writeFileSync(userConfigPath(opts()), text)
	}
	const file = () => readFileSync(userConfigPath(opts()), 'utf8')

	it('refuses Automatic without a routing default, so the file always loads', () => {
		expect(() => writeSetting({ path: 'model', value: 'auto' }, opts())).toThrow(
			/Automatic only after the routing setting/,
		)
		expect(existsSync(userConfigPath(opts()))).toBe(false)
		expect(() => checkSetting({ path: 'model', value: 'auto' }, opts())).toThrow(/routing/)
	})

	it('takes Automatic once routing has a default, and refuses to remove that default after', () => {
		writeSetting(
			{ path: 'routing', value: '{"default":{"provider":"anthropic","model":"x"}}' },
			opts(),
		)
		writeSetting({ path: 'model', value: 'auto' }, opts())
		expect(file()).toContain('model: auto')
		expect(() => writeSetting({ path: 'routing' }, opts())).toThrow(/needs a default model/)
		expect(file()).toContain('routing')
	})

	it('keeps a plain learningGenerator switch when a token number is written next to it', () => {
		seed('learningGenerator: false\n')
		writeSetting({ path: 'learningGenerator.cycleTokens', value: 50000 }, opts())
		const text = file()
		expect(text).toContain('enabled: false')
		expect(text).toContain('cycleTokens: 50000')
		// and the whole file still loads
		expect(() =>
			checkSetting({ path: 'learningGenerator.dailyTokens', value: 60000 }, opts()),
		).not.toThrow()
	})

	it('refuses a learning number above the engine maximum', () => {
		expect(() =>
			writeSetting({ path: 'learningGenerator.cycleTokens', value: 10_000_001 }, opts()),
		).toThrow(/10000000 or less/)
	})

	it('clears the save-to-file destination by removing the whole block', () => {
		writeSetting({ path: 'telemetry.sessionExport.destination', value: '/tmp/out.jsonl' }, opts())
		writeSetting({ path: 'telemetry.sessionExport.eventTypes', value: '["message"]' }, opts())
		writeSetting({ path: 'telemetry.sessionExport.destination' }, opts())
		expect(file()).not.toContain('sessionExport')
		expect(file()).not.toContain('destination')
	})

	it('checks the trace address as a web address with no password in it', () => {
		for (const bad of ['not a url', 'ftp://host/x', 'https://user:pw@host:4318'])
			expect(
				() => writeSetting({ path: 'telemetry.otlp.endpoint', value: bad }, opts()),
				bad,
			).toThrow()
		writeSetting(
			{ path: 'telemetry.otlp.endpoint', value: 'https://collector.example.com:4318' },
			opts(),
		)
		expect(file()).toContain('collector.example.com')
	})

	it('accepts one helper at once, as the loader does, and no longer describes plugin folders', () => {
		writeSetting({ path: 'workflow.maxConcurrency', value: 1 }, opts())
		expect(file()).toContain('maxConcurrency: 1')
		expect(SETTING_DESCRIPTORS.map((d) => d.path)).not.toContain('plugins.launchDirs')
	})

	it('shows each busy-provider and idle number with the range the loader enforces', () => {
		const by = (path: string) => SETTING_DESCRIPTORS.find((d) => d.path === path)?.control
		expect(by('limits.waitForProviderMs')).toMatchObject({ min: 1 })
		expect(by('schedule.maxConcurrentRuns')).toMatchObject({ min: 1, max: 16 })
		expect(by('limits.timeoutMs')).toMatchObject({ max: 2147483647 })
		expect(by('learningGenerator.dailyTokens')).toMatchObject({ max: 10000000 })
		expect(() => writeSetting({ path: 'limits.waitForProviderMs', value: 0 }, opts())).toThrow(
			/1 or more/,
		)
	})
})
