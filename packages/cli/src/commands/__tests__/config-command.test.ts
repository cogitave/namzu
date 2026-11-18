import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configCommand, parseConfigArgs } from '../config.js'
import type { CommandContext } from '../types.js'

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
		expect(await run()).toBe(2)
		expect(await run('set', 'limits.maxIterations')).toBe(2)
		expect(await run('list', '--section', 'nope')).toBe(2)
	})
})
