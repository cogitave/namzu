/**
 * The built-in skills in `packages/cli/skills/` are instructions the model
 * follows, so they are held to the code they describe: each one loads with
 * the kernel's own loader within its limits, and every `namzu …` command,
 * `namzu schedule add` flag and `/…` slash command one names in backticks
 * exists in this CLI.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvocableBy, loadSkill } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli } from '../cli.js'
import { SKILL_LISTING_DESCRIPTION_MAX_CHARS } from '../reminders/skills.js'
import { ADD_FLAGS } from '../schedule/commands/add.js'
import { CLI_LOCAL_COMMANDS } from '../tui/slashCommands.js'
import { discoverUserCommands } from '../user-commands/store.js'
import { manifestEntryChars, skillManifestBudget } from './catalog.js'
import { RETIRED_BUILTIN_SKILLS } from './retired.js'
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
	it('ships the sixteen built-in skills, and not the retired verify-change', () => {
		expect(builtinSkillDirs()).toEqual([
			'batch',
			'browser-automation',
			'commit',
			'debug',
			'deep-research',
			'document',
			'fewer-permission-prompts',
			'pr',
			'review-changes',
			'run',
			'run-skill-generator',
			'schedule-task',
			'security-review',
			'simplify',
			'skill-creator',
			'update-config',
		])
		for (const retired of Object.keys(RETIRED_BUILTIN_SKILLS))
			expect(builtinSkillDirs()).not.toContain(retired)
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
		// `run` and `run-skill-generator` fold the examples a bundled folder would have held.
		const allowance = dir === 'schedule-task' ? 200 : dir.startsWith('run') ? 50 : 0
		expect(body.split('\n').length).toBeLessThanOrEqual(150 + allowance)
		if (dir === 'run' || dir === 'review-changes') {
			expect(body).toMatch(/^# .+\n\n\S/m)
			expect(body).toMatch(/^1\. \*\*/m)
			expect(body).toMatch(/^## Never$/m)
			expect(body).toMatch(/^## Example report$/m)
			expect(readdirSync(join(SKILLS, dir))).toEqual(['SKILL.md'])
		}
	})

	it('run and review-changes trigger on what the model is about to do, with quoted examples', async () => {
		const meta = async (dir: string) =>
			(await loadSkill(join(SKILLS, dir), 'metadata')).skill.metadata
		const run = await meta('run')
		expect(run.description).toMatch(/before you tell the person a change works/)
		expect(run.description.match(/"[^"]+"/g)?.length).toBeGreaterThanOrEqual(2)
		const review = await meta('review-changes')
		expect(review.description).toMatch(/before you hand over a change you made/)
		expect(review.description.match(/"[^"]+"/g)?.length).toBeGreaterThanOrEqual(2)
		expect(run.invocation).toBe('both')
		expect(review.invocation).toBe('both')
		expect(run.metadata?.['namzu-requires-tools']).toBeUndefined()
		expect(review.metadata?.['namzu-requires-tools']).toBeUndefined()
	})

	it('run and its generator match how skills are discovered and stay read-only', () => {
		const run = readFileSync(join(SKILLS, 'run', 'SKILL.md'), 'utf8')
		const gen = readFileSync(join(SKILLS, 'run-skill-generator', 'SKILL.md'), 'utf8')
		// `.namzu/skills` is read from the working folder alone, never walked up.
		expect(run).not.toMatch(/\$d"\/\.namzu\/skills/)
		expect(run).toMatch(/read that `SKILL\.md` with\s+the read tool/)
		expect(gen).toMatch(/`save_skill` cannot be used/)
		expect(gen).not.toMatch(/is fixed by installing it/)
		// A server is stopped by a recorded pid, with a fallback when `lsof` is missing.
		expect(run).toMatch(/Record the pid/)
		expect(run).toMatch(/ss -ltnp/)
		expect(run).not.toMatch(/Stop it by the process that holds the port \(`lsof/)
		expect(run).toMatch(/Edit, add or delete project source or tests while running/)
		expect(run).toMatch(/never swap them for\s+placeholders/)
		const config = readFileSync(join(SKILLS, 'update-config', 'SKILL.md'), 'utf8')
		expect(config).toMatch(/a deny anywhere wins/)
	})

	it('run tells the model to run the check plainly, as the turn record reads it', async () => {
		const body = (await loadSkill(join(SKILLS, 'run'), 'full')).skill.body ?? ''
		expect(body).toMatch(/no pipe/)
		expect(body).toMatch(/inconclusive/)
		for (const verdict of ['It works', 'It does not', 'It could not be exercised'])
			expect(body.toLowerCase()).toContain(verdict.toLowerCase())
		// A probe beside the change, and the project's own run skill first.
		expect(body).toMatch(/Probe around the change/)
		expect(body).toMatch(/\.namzu\/skills\/\*\/SKILL\.md/)
		expect(body).toMatch(/\.agents\/skills\/\*\/SKILL\.md/)
	})

	it('run-skill-generator is for the operator, writes where Namzu reads project skills, and only after a real run', async () => {
		const { skill } = await loadSkill(join(SKILLS, 'run-skill-generator'), 'full')
		expect(skill.metadata.invocation).toBe('operator')
		const body = skill.body ?? ''
		expect(body).toContain('.namzu/skills/run-<unit>/SKILL.md')
		expect(body).toContain('.agents/skills/run-<unit>/')
		expect(body).toContain('save_skill')
		expect(body).toMatch(/Done means all four/)
	})

	it("the skills that act on the project are the operator's to start, not the model's", async () => {
		for (const dir of [
			'batch',
			'commit',
			'debug',
			'fewer-permission-prompts',
			'pr',
			'run-skill-generator',
			'security-review',
			'simplify',
			'update-config',
		]) {
			const { skill } = await loadSkill(join(SKILLS, dir), 'metadata')
			expect(skill.metadata.invocation, dir).toBe('operator')
			expect(isInvocableBy(skill, 'model'), dir).toBe(false)
		}
	})

	it('commit and pr never push or stage everything on their own', async () => {
		const commit = (await loadSkill(join(SKILLS, 'commit'), 'full')).skill.body ?? ''
		expect(commit).toMatch(/Never\s+`git add -A`/)
		expect(commit).toMatch(/Push, force-push, amend or rebase/)
		expect(commit).toMatch(/--no-verify/)
		const pr = (await loadSkill(join(SKILLS, 'pr'), 'full')).skill.body ?? ''
		expect(pr).toMatch(/Do not open a pull request from the default branch/)
		expect(pr).toMatch(/Push to the default branch, force-push/)
	})

	it('security-review only reports, and batch asks before it starts any helper', async () => {
		const security = (await loadSkill(join(SKILLS, 'security-review'), 'full')).skill.body ?? ''
		expect(security).toMatch(/Report only\. You change no file/)
		const batch = (await loadSkill(join(SKILLS, 'batch'), 'full')).skill.body ?? ''
		expect(batch).toMatch(/Show the plan and wait for a yes/)
		expect(batch).toContain('workspace: "worktree"')
	})

	it.each(['run', 'review-changes'])(
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
		const known = new Set([
			'Agent',
			'schedule',
			'browser',
			'browser_act',
			'save_skill',
			'skill',
			'bash',
			'web_search',
			'web_fetch',
			'wait_for_task',
			'present_file',
		])
		const problems: string[] = []
		for (const dir of builtinSkillDirs()) {
			const markdown = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8')
			for (const m of markdown.matchAll(/`([A-Za-z_]+)` tool\b/g))
				if (!known.has(m[1] as string)) problems.push(`${dir}: ${m[1]}`)
		}
		expect(problems).toEqual([])
	})

	it('the descriptions the model is offered fit in full on the smallest window the model table lists for open weights', async () => {
		// 32,768 tokens is the smallest window the table gives a current family
		// (the 8k and 16k rows are older chat models). A real install sits under
		// a path of this length, which every entry also pays for. Skills only the
		// operator starts are not described to the model and cost nothing here.
		const installedPath = `/usr/local/lib/node_modules/@namzu/cli/skills/${'x'.repeat(20)}`
		const budget = skillManifestBudget(32_768)
		let spent = 0
		let offered = 0
		for (const dir of builtinSkillDirs()) {
			const { skill } = await loadSkill(join(SKILLS, dir), 'metadata')
			expect(skill.metadata.description.length).toBeLessThanOrEqual(
				SKILL_LISTING_DESCRIPTION_MAX_CHARS,
			)
			if (!isInvocableBy(skill, 'model')) continue
			// Offered only where Agent and both web tools exist; where the manifest is
			// over budget it is named, not described, and stays loadable.
			if (dir === 'deep-research') continue
			offered++
			spent += manifestEntryChars({ ...skill, dirPath: installedPath })
		}
		expect(offered).toBe(6)
		expect(spent).toBeLessThanOrEqual(budget)
	})

	it('deep-research is gated on Agent and the web tools and keeps its sourcing rules', async () => {
		const { skill } = await loadSkill(join(SKILLS, 'deep-research'), 'full')
		expect(skill.metadata.invocation).toBe('both')
		expect(skill.metadata.metadata?.['namzu-requires-tools']).toBe('Agent, web_search, web_fetch')
		const body = skill.body ?? ''
		// no invented URLs, and a snippet is not a source
		expect(body).toMatch(/never write or complete a URL from memory/i)
		expect(body).toMatch(/a search snippet is not a\s+source/i)
		// every claim is tied to a page fetched in this run
		expect(body).toMatch(/\[n\]/)
		expect(body).toMatch(/from this run/)
		expect(body).toMatch(/No URL appears that\s+no researcher returned/)
		// the budget: researcher caps, one gap round, a search and fetch budget
		expect(body).toMatch(/never more than 9/i)
		expect(body).toMatch(/Never more than 4 at once/)
		expect(body).toMatch(/at most 2 more\s+researchers/)
		expect(body).toMatch(/about 8 `web_search` calls and 10 `web_fetch` calls/)
		expect(body).toMatch(/`present_file`/)
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
		const run = await meta('run')
		expect(run.invocation).toBe('both')
		const schedule = await meta('schedule-task')
		expect(schedule.invocation).toBe('both')
		expect(schedule.metadata?.['namzu-requires-tools']).toBe('schedule')
	})

	it.each(builtinSkillDirs())('%s names only commands this CLI has', (dir) => {
		const markdown = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8')
		const scheduleSource = readFileSync(SCHEDULE_SOURCE, 'utf8')
		const addFlags = new Set(ADD_FLAGS.map((flag) => flag.replace(/!$/, '')))
		// A built-in skill the person can invoke is a slash command too.
		const slashNames = new Set([
			...CLI_LOCAL_COMMANDS.map((command) => command.name),
			...builtinSkillDirs().filter((name) => name !== 'browser-automation'),
		])
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
				if (!slashNames.has(name as string)) {
					problems.push(`${span}: no slash command /${name}`)
					continue
				}
				if (!command) continue
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

describe('the built-in skills as slash commands', () => {
	it('/run and the other operator skills are commands that no local command shadows', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-builtin-cmds-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-builtin-cwd-'))
		try {
			const commands = discoverUserCommands({
				home,
				cwd,
				skillCommands: 'all',
				reserved: CLI_LOCAL_COMMANDS.map((command) => command.name),
			})
			for (const name of ['run', 'run-skill-generator', 'simplify', 'commit', 'pr', 'batch']) {
				const found = commands.find((command) => command.name === name)
				expect(found, name).toBeDefined()
				expect(found?.problem, name).toBeUndefined()
				expect(found?.source).toBe('skill')
			}
			expect(commands.find((command) => command.name === 'verify-change')).toBeUndefined()
			expect(commands.find((command) => command.name === 'browser-automation')).toBeUndefined()
		} finally {
			rmSync(home, { recursive: true, force: true })
			rmSync(cwd, { recursive: true, force: true })
		}
	})
})

describe('the document skill description', () => {
	it('sends a research or analysis request back to the reply', () => {
		const text = readFileSync(join(SKILLS, 'document', 'SKILL.md'), 'utf8')
		expect(text).toContain('a research or analysis request is answered in the reply')
	})
})
