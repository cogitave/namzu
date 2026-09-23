/**
 * The built-in skills in `packages/cli/skills/` are instructions the model
 * follows, so they are held to the code they describe: each one loads with
 * the kernel's own loader within its limits, and every `namzu …` command,
 * `namzu schedule add` flag and `/…` slash command one names in backticks
 * exists in this CLI.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSkill } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli } from '../cli.js'
import { ADD_FLAGS } from '../schedule/commands/add.js'
import { CLI_LOCAL_COMMANDS } from '../tui/slashCommands.js'
import { SKILL_BODY_MAX_BYTES, SKILL_DESCRIPTION_MAX_CHARS, SKILL_NAME_MAX_CHARS } from './save.js'
import { systemSkillsDir } from './store.js'

const SKILLS = systemSkillsDir()
const SCHEDULE_SOURCE = fileURLToPath(new URL('../commands/schedule.ts', import.meta.url))

/**
 * Commands a skill may name before this CLI has them, each with the reason.
 * `browser-automation` is offered only when the `browser` tool exists, and
 * `schedule-task` names the login step for the scheduled browser grant: both
 * arrive with the browser feature (`namzu browser login|list|status|install|remove`).
 */
const PENDING_COMMANDS: Readonly<Record<string, string>> = {
	browser: 'comes with the browser feature',
}

function builtinSkillDirs(): string[] {
	return readdirSync(SKILLS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, 'SKILL.md')))
		.map((entry) => entry.name)
		.sort()
}

function backticked(markdown: string): string[] {
	return [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] as string)
}

let helpText: string
let stdoutWrite: typeof process.stdout.write

beforeEach(async () => {
	if (helpText !== undefined) return
	let captured = ''
	stdoutWrite = process.stdout.write.bind(process.stdout)
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
		return true
	}) as typeof process.stdout.write
	try {
		await runCli({ argv: ['node', 'namzu', '--help'] })
	} finally {
		process.stdout.write = stdoutWrite
	}
	helpText = captured
})
afterEach(() => {
	if (stdoutWrite) process.stdout.write = stdoutWrite
})

function topLevelCommandExists(name: string): boolean {
	return new RegExp(`^\\s+${name.replace(/[-]/g, '\\-')}\\b`, 'm').test(helpText)
}

describe('the built-in skills', () => {
	it('ships skill-creator, browser-automation and schedule-task', () => {
		expect(builtinSkillDirs()).toEqual(
			expect.arrayContaining(['browser-automation', 'schedule-task', 'skill-creator']),
		)
	})

	it.each(builtinSkillDirs())('%s loads with the kernel loader within its limits', async (dir) => {
		const { skill } = await loadSkill(join(SKILLS, dir), 'full')
		expect(skill.metadata.name).toBe(dir)
		expect(skill.metadata.name.length).toBeLessThanOrEqual(SKILL_NAME_MAX_CHARS)
		expect(skill.metadata.description.length).toBeGreaterThan(40)
		expect(skill.metadata.description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX_CHARS)
		// Trigger-oriented: the description says when to use it.
		expect(skill.metadata.description).toMatch(/\bUse (when|whenever)\b/)
		expect(Buffer.byteLength(skill.body ?? '', 'utf8')).toBeLessThanOrEqual(SKILL_BODY_MAX_BYTES)
		expect((skill.body ?? '').length).toBeGreaterThan(200)
	})

	it('declares the invocation and gating the design gives each', async () => {
		const meta = async (dir: string) =>
			(await loadSkill(join(SKILLS, dir), 'metadata')).skill.metadata
		const creator = await meta('skill-creator')
		expect(creator.invocation).toBe('both')
		expect(creator.metadata?.['namzu-requires-tools']).toBeUndefined()
		const browser = await meta('browser-automation')
		expect(browser.invocation).toBe('model')
		expect(browser.metadata?.['namzu-requires-tools']).toBe('browser')
		const schedule = await meta('schedule-task')
		expect(schedule.invocation).toBe('both')
		expect(schedule.metadata?.['namzu-requires-tools']).toBe('schedule')
	})

	it.each(builtinSkillDirs())('%s names only commands this CLI has', (dir) => {
		const markdown = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8')
		const scheduleSource = readFileSync(SCHEDULE_SOURCE, 'utf8')
		const addFlags = new Set(ADD_FLAGS.map((flag) => flag.replace(/!$/, '')))
		const slashNames = new Set(CLI_LOCAL_COMMANDS.map((command) => command.name))
		const problems: string[] = []
		for (const span of backticked(markdown)) {
			if (span === 'namzu' || span.startsWith('namzu ')) {
				const words = span.split(/\s+/).slice(1)
				const command = words[0]
				if (command === undefined || command.startsWith('-')) continue
				if (PENDING_COMMANDS[command]) continue
				if (!topLevelCommandExists(command)) {
					problems.push(`${span}: no command "${command}"`)
					continue
				}
				if (command === 'schedule') {
					const verb = words[1]
					if (verb && !verb.startsWith('-') && !scheduleSource.includes(`case '${verb}':`))
						problems.push(`${span}: no "schedule ${verb}"`)
					if (verb === 'add') {
						for (const word of words) {
							if (!word.startsWith('--')) continue
							const flag = word.slice(2).split('=')[0] as string
							if (!addFlags.has(flag)) problems.push(`${span}: no --${flag} on schedule add`)
						}
					}
				}
				continue
			}
			const slash = /^\/([a-z][a-z-]*)(?:\s+(\S+))?/.exec(span)
			if (slash && !span.includes('/', 1) && !span.startsWith('/etc')) {
				const [, name, sub] = slash
				const command = CLI_LOCAL_COMMANDS.find((c) => c.name === name)
				if (!command || !slashNames.has(name as string)) {
					problems.push(`${span}: no slash command /${name}`)
					continue
				}
				if (name === 'skills' && sub === 'new') {
					const action = command.action({} as never, ['new'])
					if (action.kind !== 'new-skill') problems.push(`${span}: /skills new is not a subcommand`)
				}
			}
		}
		expect(problems).toEqual([])
	})
})
