import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readSettings } from '../../config/desktop-settings.js'
import { SETTING_DESCRIPTORS, type SettingDescriptor } from '../../config/settings-descriptors.js'
import { configCommand, parseConfigArgs, shellWord } from '../config.js'
import type { CommandContext } from '../types.js'

const typed = vi.hoisted(() => ({ answer: 'n' }))
vi.mock('node:readline', () => ({
	createInterface: () => ({
		question: (_q: string, done: (a: string) => void) => done(typed.answer),
		close: () => {},
	}),
}))

let home: string
let out: string
let err: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-config-command-'))
	vi.stubEnv('NAMZU_HOME', home)
	out = ''
	err = ''
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		out += String(chunk)
		return true
	})
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		err += String(chunk)
		return true
	})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(home, { recursive: true, force: true })
})

const run = (...rawArgs: string[]) => configCommand.handler({ ctx: {} as CommandContext, rawArgs })

describe('namzu config', () => {
	it('parses flags', () => {
		expect(parseConfigArgs(['list', '--section', 'agent', '--json'])).toMatchObject({
			positional: ['list'],
			section: 'agent',
			json: true,
		})
		expect(parseConfigArgs(['set', 'a', '1', '-y']).yes).toBe(true)
		expect(parseConfigArgs(['--nope']).error).toMatch(/unknown option/)
	})

	it('sets, gets, lists and unsets through the user file', async () => {
		expect(await run('set', 'limits.maxIterations', '20')).toBe(0)
		expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('maxIterations: 20')
		out = ''
		expect(await run('get', 'limits.maxIterations')).toBe(0)
		expect(out).toContain('Value:    20')
		out = ''
		expect(await run('list', '--json')).toBe(0)
		const listed = JSON.parse(out) as { settings: { key: string; value?: number }[] }
		expect(listed.settings.find((s) => s.key === 'limits.maxIterations')?.value).toBe(20)
		// Clearing a cap asks, as it does in Desktop; there is no terminal here.
		expect(await run('unset', 'limits.maxIterations')).toBe(1)
		expect(await run('unset', 'limits.maxIterations', '--yes')).toBe(0)
		expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('maxIterations')
	})

	it('refuses with exit 1 and a risky change without --yes when there is no terminal', async () => {
		expect(await run('set', 'limits.maxIterations', 'banana')).toBe(1)
		expect(err).toContain('Enter a number.')
		err = ''
		expect(await run('set', 'permissions.defaultMode', 'bypass')).toBe(1)
		expect(err).toContain('--yes')
		expect(await run('set', 'permissions.defaultMode', 'bypass', '--yes')).toBe(0)
		expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('defaultMode: bypass')
	})

	it('exits 2 for a usage mistake', async () => {
		expect(await run()).toBe(64)
		expect(await run('set', 'limits.maxIterations')).toBe(64)
		expect(await run('list', '--section', 'nope')).toBe(64)
	})

	it('quotes a value in the retry hint so the line can be pasted', async () => {
		expect(shellWord('20')).toBe('20')
		expect(shellWord('{"a":"b c"}')).toBe(`'{"a":"b c"}'`)
		expect(shellWord("it's")).toBe(`'it'\\''s'`)
		expect(shellWord('')).toBe("''")
		expect(await run('set', 'permissions.defaultMode', 'bypass')).toBe(1)
		expect(err).toContain('namzu config set permissions.defaultMode bypass --yes')
		err = ''
		expect(await run('set', 'permissions', '{"bash":"allow"}')).toBe(1)
		expect(err).toContain(`namzu config set permissions '{"bash":"allow"}' --yes`)
	})

	it('lists and gets exactly the described settings, including one added to the description', async () => {
		const fake: SettingDescriptor = {
			path: 'limits.fakeAddedForCommandTest',
			label: 'A fake row',
			description: 'Only the test has this.',
			section: 'agent',
			control: { kind: 'number', min: 2, max: 9 },
			default: 4,
			appliesWhen: 'next-turn',
		}
		const descriptors = SETTING_DESCRIPTORS as SettingDescriptor[]
		descriptors.push(fake)
		try {
			expect(await run('list', '--json')).toBe(0)
			const listed = JSON.parse(out) as {
				settings: { key: string; default?: unknown; control: unknown }[]
			}
			const desktop = readSettings({ home, env: {} as NodeJS.ProcessEnv })
			// Listed in the order of the Settings nav, so compare as sets.
			expect(listed.settings.map((s) => s.key).sort()).toEqual(
				descriptors.map((d) => d.path).sort(),
			)
			for (const row of listed.settings) {
				const seen = desktop.descriptors.find((d) => d.path === row.key)
				expect(row.default, row.key).toEqual(seen?.default)
				expect(row.control, row.key).toEqual(seen?.control)
			}
			for (const descriptor of descriptors) {
				out = ''
				expect(await run('get', descriptor.path, '--json'), descriptor.path).toBe(0)
				expect(JSON.parse(out).key).toBe(descriptor.path)
			}
		} finally {
			descriptors.pop()
		}
		expect(await run('get', 'limits.fakeAddedForCommandTest')).toBe(1)
	})

	describe('on a terminal', () => {
		const setTty = (value: boolean) => {
			for (const stream of [process.stdin, process.stderr]) {
				Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true })
			}
		}
		afterEach(() => {
			for (const stream of [process.stdin, process.stderr]) Reflect.deleteProperty(stream, 'isTTY')
		})
		const answer = (text: string) => {
			typed.answer = text
		}

		it('asks and changes on y', async () => {
			setTty(true)
			answer('y')
			expect(await run('set', 'permissions.defaultMode', 'bypass')).toBe(0)
			expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('defaultMode: bypass')
		})

		it('asks and leaves the file alone on n', async () => {
			setTty(true)
			answer('n')
			expect(await run('set', 'permissions.defaultMode', 'bypass')).toBe(1)
			expect(err).toContain('Not changed.')
			expect(existsSync(join(home, 'config.yaml'))).toBe(false)
		})
	})
})
