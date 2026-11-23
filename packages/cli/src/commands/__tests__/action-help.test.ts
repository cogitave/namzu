import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type ActionHelp, flagNames, renderActionHelp, resolveActionHelp } from '../action-help.js'
import { archiveCommand } from '../archive.js'
import { createAuthCommand } from '../auth.js'
import { browserCommand } from '../browser.js'
import { computerCommand } from '../computer.js'
import { parseConfigArgs } from '../config.js'
import { configCommand } from '../config.js'
import { parseExtensionArgs } from '../extension.js'
import { extensionCommand } from '../extension.js'
import { parseInstallArgs } from '../github.js'
import { githubCommand } from '../github.js'
import { mcpCommand } from '../mcp.js'
import { createPalCommand } from '../pal.js'
import { peersCommand } from '../peers.js'
import { pluginCommand } from '../plugin.js'
import { providersCommand } from '../providers.js'
import { scheduleCommand } from '../schedule.js'
import { skillsCommand } from '../skills.js'
import { stateCommand } from '../state.js'
import type { CommandDef } from '../types.js'
import { createWorktreeCommand } from '../worktree.js'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The areas with actions, and the source files whose parsers read their flags. */
const AREAS: ReadonlyArray<{ def: CommandDef; sources: readonly string[] }> = [
	{
		def: scheduleCommand,
		sources: [
			'schedule/commands/add.ts',
			'schedule/commands/lifecycle.ts',
			'schedule/commands/list.ts',
			'schedule/commands/logs.ts',
			'schedule/commands/service.ts',
			'schedule/service/target.ts',
		],
	},
	{ def: browserCommand, sources: ['browser/commands.ts'] },
	{
		def: createAuthCommand({ discover: async () => [] }),
		sources: ['commands/auth.ts', 'commands/login.ts'],
	},
	{ def: configCommand, sources: ['commands/config.ts'] },
	{ def: computerCommand, sources: ['computer/run.ts'] },
	{ def: stateCommand, sources: ['commands/state.ts'] },
	{ def: skillsCommand, sources: ['commands/skills.ts'] },
	{ def: providersCommand, sources: ['commands/providers.ts'] },
	{ def: createWorktreeCommand(), sources: [] },
	{ def: archiveCommand, sources: ['commands/archive.ts'] },
	{ def: pluginCommand, sources: ['commands/plugin.ts'] },
	{ def: githubCommand, sources: ['commands/github.ts'] },
	{
		def: mcpCommand,
		sources: ['commands/mcp.ts', 'commands/mcp-serve.ts', 'commands/mcp-oauth-login.ts'],
	},
	{ def: extensionCommand, sources: ['commands/extension.ts'] },
	{ def: peersCommand, sources: ['commands/peers.ts'] },
	{
		def: createPalCommand(),
		sources: ['commands/pal.ts', 'pals/activity-command.ts', 'pals/message-command.ts'],
	},
]

const actionsOf = (def: CommandDef): readonly ActionHelp[] => def.actions ?? []

describe('per-action help tables', () => {
	for (const { def, sources } of AREAS) {
		describe(def.name, () => {
			const actions = actionsOf(def)

			it('declares its actions', () => {
				expect(actions.length).toBeGreaterThan(0)
			})

			it('gives every action a usage line, one sentence and an example of its own', () => {
				for (const action of actions) {
					const text = renderActionHelp(def.name, action)
					const words = `namzu ${def.name} ${action.path.join(' ')}`
					expect(text.startsWith(words), words).toBe(true)
					expect(action.summary.trim().endsWith('.'), `${words}: summary`).toBe(true)
					expect(action.example.startsWith(words), `${words}: example`).toBe(true)
					expect(text).toContain('-h, --help')
					// What the registry would print for `namzu <area> <action> --help`.
					expect(resolveActionHelp(def.name, actions, [...action.path, '--help'])).toBe(text)
				}
			})

			it('lists only flags its parser reads', () => {
				const source = sources.map((file) => readFileSync(resolve(SRC, file), 'utf8')).join('\n')
				for (const action of actions) {
					for (const { flag } of action.flags ?? []) {
						for (const name of flagNames(flag)) {
							const bare = name.replace(/^--?/, '')
							const spelled = [`'${name}'`, `"${name}"`, `'${bare}'`, `'${bare}!'`, `\`${name}\``]
							expect(
								spelled.some((s) => source.includes(s)),
								`${def.name} ${action.path.join(' ')}: ${name}`,
							).toBe(true)
						}
					}
				}
			})
		})
	}

	it('answers a group word with the actions under it', () => {
		const text = resolveActionHelp('schedule', actionsOf(scheduleCommand), ['service', '--help'])
		expect(text?.startsWith('namzu schedule service')).toBe(true)
		expect(text).toContain('install')
		expect(text).toContain('logs')
	})

	it('falls back to the area for words that name no action', () => {
		expect(
			resolveActionHelp('schedule', actionsOf(scheduleCommand), ['nope', '--help']),
		).toBeUndefined()
		expect(resolveActionHelp('schedule', actionsOf(scheduleCommand), ['--help'])).toBeUndefined()
	})

	it('takes the longest matching path and ignores operands after it', () => {
		const text = resolveActionHelp('schedule', actionsOf(scheduleCommand), [
			'service',
			'status',
			'main',
			'--help',
		])
		expect(text?.startsWith('namzu schedule service status')).toBe(true)
	})
})

describe('declared flags run through the real parsers', () => {
	const take = (flag: string): [string, boolean] => {
		const first = flagNames(flag)[0] as string
		return [first, /<[^>]+>/.test(flag)]
	}

	it('config', () => {
		for (const action of actionsOf(configCommand))
			for (const { flag } of action.flags ?? []) {
				const [name, value] = take(flag)
				const parsed = parseConfigArgs(value ? [name, 'x'] : [name])
				expect(parsed.error, `config ${action.path}: ${name}`).toBeUndefined()
			}
	})

	it('extension', () => {
		for (const action of actionsOf(extensionCommand))
			for (const { flag } of action.flags ?? []) {
				const [name, value] = take(flag)
				const parsed = parseExtensionArgs([
					action.path[0] as string,
					'id',
					name,
					...(value ? ['x'] : []),
				])
				expect(parsed.error, `extension ${action.path}: ${name}`).toBeUndefined()
			}
	})

	it('github', () => {
		for (const action of actionsOf(githubCommand))
			for (const { flag } of action.flags ?? []) {
				const [name, value] = take(flag)
				const parsed = parseInstallArgs([
					name,
					...(value ? [name === '--workflow' ? 'review' : name === '--budget' ? '2' : 'x'] : []),
				])
				expect('error' in parsed ? parsed.error : undefined, `github: ${name}`).toBeUndefined()
			}
	})
})
