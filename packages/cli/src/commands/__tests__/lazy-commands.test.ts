import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'

import { lazyCommand } from '../lazy.js'
import * as manifest from '../manifest.js'
import { registerCommand } from '../registry.js'
import type { CommandContext, CommandDef } from '../types.js'

/**
 * `namzu --version` and `namzu --help` are answered by commander before any
 * command runs, so a command's module must not be imported until it does.
 * These tests hold the registry to that, and hold the lightweight definitions
 * in the manifest to the real ones they stand in for.
 */

function run(def: ReturnType<typeof lazyCommand>, argv: string[]) {
	const printed: string[] = []
	let exit: number | undefined
	const program = new Command().exitOverride().enablePositionalOptions()
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (data: unknown) => printed.push(String((data as { text?: string }).text ?? data)),
			info: () => {},
			error: () => {},
		},
		config: {},
	} as unknown as CommandContext
	registerCommand(program, def, {
		getContext: () => ctx,
		setExitCode: (code) => {
			exit = code
		},
	})
	return {
		program,
		printed,
		exit: () => exit,
		parse: () => program.parseAsync(['node', 'namzu', ...argv], { from: 'node' }),
	}
}

describe('a lazy command', () => {
	it('is not loaded by registering it, by the root help, or by an unrelated command', async () => {
		const load = vi.fn(
			async (): Promise<CommandDef> => ({
				name: 'later',
				description: 'x',
				passThrough: true,
				handler: async () => 0,
			}),
		)
		const lazy = lazyCommand({ name: 'later', description: 'x', passThrough: true }, load)
		const h = run(lazy, [])

		expect(h.program.helpInformation()).toContain('later')
		expect(load).not.toHaveBeenCalled()
	})

	it('is loaded once, when it runs, and its handler gets the arguments', async () => {
		const handler = vi.fn(async () => 7)
		const load = vi.fn(
			async (): Promise<CommandDef> => ({
				name: 'later',
				description: 'x',
				passThrough: true,
				handler,
			}),
		)
		const h = run(lazyCommand({ name: 'later', description: 'x', passThrough: true }, load), [
			'later',
			'a',
			'--b',
		])

		await h.parse()
		await h.parse()

		expect(load).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ rawArgs: ['a', '--b'] }))
		expect(h.exit()).toBe(7)
	})

	it('answers --help with the loaded definition’s help text, without running the handler', async () => {
		const handler = vi.fn(async () => 0)
		const lazy = lazyCommand({ name: 'later', description: 'x', passThrough: true }, async () => ({
			name: 'later',
			description: 'x',
			passThrough: true,
			help: 'Usage: namzu later',
			handler,
		}))
		const h = run(lazy, ['later', '--help'])

		await h.parse()

		expect(h.printed).toEqual(['Usage: namzu later'])
		expect(handler).not.toHaveBeenCalled()
		expect(h.exit()).toBe(0)
	})

	it('tries again after a failed load instead of remembering the failure', async () => {
		let attempts = 0
		const lazy = lazyCommand({ name: 'later', description: 'x' }, async () => {
			attempts++
			if (attempts === 1) throw new Error('transient')
			return { name: 'later', description: 'x', handler: async () => 3 }
		})

		await expect(lazy.load()).rejects.toThrow('transient')
		await expect(lazy.load()).resolves.toMatchObject({ name: 'later' })
	})
})

describe('the command manifest', () => {
	const lazies = [
		...Object.entries(manifest)
			.filter(([, value]) => typeof value === 'object')
			.map(([, value]) => value as ReturnType<typeof lazyCommand>),
		manifest.createLazyPalCommand(),
		manifest.createLazyWorktreeCommand(async () => {}),
	]

	it('lists every command', () => {
		expect(lazies.map((def) => def.name).sort()).toEqual(
			[
				'acp',
				'archive',
				'browser',
				'computer',
				'doctor',
				'drain',
				'eval',
				'exec',
				'history',
				'login',
				'logout',
				'mcp',
				'pal',
				'providers-json',
				'resident',
				'schedule',
				'serve',
				'skills',
				'skills-json',
				'state',
				'upgrade',
				'worktree',
			].sort(),
		)
	})

	it.each(lazies.map((def) => [def.name, def] as const))(
		'describes %s exactly as the command itself does',
		async (_name, lazy) => {
			const real = await lazy.load()

			expect({
				name: lazy.name,
				aliases: lazy.aliases,
				description: lazy.description,
				passThrough: lazy.passThrough,
			}).toEqual({
				name: real.name,
				aliases: real.aliases,
				description: real.description,
				passThrough: real.passThrough,
			})
		},
	)
})
