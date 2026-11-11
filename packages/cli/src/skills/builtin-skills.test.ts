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
import { SKILL_LISTING_DESCRIPTION_MAX_CHARS } from '../reminders/skills.js'
import { ADD_FLAGS } from '../schedule/commands/add.js'
import { CLI_LOCAL_COMMANDS } from '../tui/slashCommands.js'
import { manifestEntryChars, skillManifestBudget } from './catalog.js'
import { SKILL_BODY_MAX_BYTES, SKILL_DESCRIPTION_MAX_CHARS, SKILL_NAME_MAX_CHARS } from './save.js'
import { systemSkillsDir } from './store.js'

const SKILLS = systemSkillsDir()
const SCHEDULE_SOURCE = fileURLToPath(new URL('../commands/schedule.ts', import.meta.url))

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
	it('ships the five built-in skills', () => {
		expect(builtinSkillDirs()).toEqual([
			'browser-automation',
			'review-changes',
			'schedule-task',
			'skill-creator',
			'verify-change',
		])
	})

	it.each(builtinSkillDirs())('%s loads with the kernel loader within its limits', async (dir) => {
		const { skill } = await loadSkill(join(SKILLS, dir), 'full')
		expect(skill.metadata.name).toBe(dir)
		expect(skill.metadata.name.length).toBeLessThanOrEqual(SKILL_NAME_MAX_CHARS)
		expect(skill.metadata.description.length).toBeGreaterThan(40)
		expect(skill.metadata.description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX_CHARS)
		// Trigger-oriented: the description says when to use it.
		expect(skill.metadata.description).toMatch(/\bUse (when|whenever|before)\b/)
		expect(Buffer.byteLength(skill.body ?? '', 'utf8')).toBeLessThanOrEqual(SKILL_BODY_MAX_BYTES)
		expect((skill.body ?? '').length).toBeGreaterThan(200)
	})

	it.each(builtinSkillDirs())('%s says when not to use it, and fits its own rules', async (dir) => {
		const { skill } = await loadSkill(join(SKILLS, dir), 'full')
		// A description that says when NOT to use the skill, where a neighbour is easily confused with it.
		expect(skill.metadata.description).toMatch(/\bNot (for|a)\b/)
		// The rules `skill-creator` gives: one file, a short body, a summary, numbered steps, a "Never" list.
		const body = skill.body ?? ''
		expect(body.split('\n').length).toBeLessThanOrEqual(150 + (dir === 'schedule-task' ? 200 : 0))
		if (dir === 'verify-change' || dir === 'review-changes') {
			expect(body).toMatch(/^# .+\n\n\S/m)
			expect(body).toMatch(/^1\. \*\*/m)
			expect(body).toMatch(/^## Never$/m)
			expect(body).toMatch(/^## Example report$/m)
			expect(readdirSync(join(SKILLS, dir))).toEqual(['SKILL.md'])
		}
	})

	it('verify-change and review-changes trigger on what the model is about to do, with quoted examples', async () => {
		const meta = async (dir: string) =>
			(await loadSkill(join(SKILLS, dir), 'metadata')).skill.metadata
		const verify = await meta('verify-change')
		expect(verify.description).toMatch(/before you tell the person a change works/)
		expect(verify.description.match(/"[^"]+"/g)?.length).toBeGreaterThanOrEqual(2)
		const review = await meta('review-changes')
		expect(review.description).toMatch(/before you hand over a change you made/)
		expect(review.description.match(/"[^"]+"/g)?.length).toBeGreaterThanOrEqual(2)
		expect(verify.invocation).toBe('both')
		expect(review.invocation).toBe('both')
		expect(verify.metadata?.['namzu-requires-tools']).toBeUndefined()
		expect(review.metadata?.['namzu-requires-tools']).toBeUndefined()
	})

	it('verify-change tells the model to run the check plainly, as the turn record reads it', async () => {
		const body = (await loadSkill(join(SKILLS, 'verify-change'), 'full')).skill.body ?? ''
		expect(body).toMatch(/no pipe/)
		expect(body).toMatch(/inconclusive/)
		for (const verdict of ['It works', 'It does not', 'It could not be exercised'])
			expect(body).toContain(verdict)
	})

	it.each(['verify-change', 'review-changes'])(
		'%s tells the model to stay within permissions and ask before anything irreversible',
		async (dir) => {
			const body = (await loadSkill(join(SKILLS, dir), 'full')).skill.body ?? ''
			const never = body.split(/^## Never$/m)[1]?.split(/^## /m)[0] ?? ''
			expect(never).toMatch(/permissions allow/)
			expect(never).toMatch(/cannot\s+be undone/)
			expect(never).toMatch(/without asking first/)
			for (const word of ['push', 'install', 'live service']) expect(never).toContain(word)
		},
	)

	it('review-changes names the delegation tool by the name the kernel registers', async () => {
		const body = (await loadSkill(join(SKILLS, 'review-changes'), 'full')).skill.body ?? ''
		const registered = readFileSync(
			fileURLToPath(new URL('../../../sdk/src/tools/coordinator/agent.ts', import.meta.url)),
			'utf8',
		)
		const tool = /\bthe `([A-Za-z_]+)` tool is available/.exec(body)?.[1]
		expect(tool).toBeDefined()
		expect(registered).toContain(`name: '${tool}'`)
	})

	it('every `name` tool a built-in points at by "the `x` tool" is one this CLI or the kernel registers', () => {
		const known = new Set(['Agent', 'schedule', 'browser', 'browser_act', 'save_skill', 'skill'])
		const problems: string[] = []
		for (const dir of builtinSkillDirs()) {
			const markdown = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8')
			for (const m of markdown.matchAll(/`([A-Za-z_]+)` tool\b/g))
				if (!known.has(m[1] as string)) problems.push(`${dir}: ${m[1]}`)
		}
		expect(problems).toEqual([])
	})

	it('all five descriptions fit in full on the smallest window the model table lists for open weights', async () => {
		// 32,768 tokens is the smallest window the table gives a current family
		// (the 8k and 16k rows are older chat models). A real install sits under
		// a path of this length, which every entry also pays for.
		const installedPath = `/usr/local/lib/node_modules/@namzu/cli/skills/${'x'.repeat(20)}`
		const budget = skillManifestBudget(32_768)
		let spent = 0
		for (const dir of builtinSkillDirs()) {
			const { skill } = await loadSkill(join(SKILLS, dir), 'metadata')
			expect(skill.metadata.description.length).toBeLessThanOrEqual(
				SKILL_LISTING_DESCRIPTION_MAX_CHARS,
			)
			spent += manifestEntryChars({ ...skill, dirPath: installedPath })
		}
		expect(spent).toBeLessThanOrEqual(budget)
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
				if (name === 'skills' && sub === 'save') {
					const action = command.action({} as never, ['save'])
					if (action.kind !== 'save-skill')
						problems.push(`${span}: /skills save is not a subcommand`)
				}
			}
		}
		expect(problems).toEqual([])
	})
})
