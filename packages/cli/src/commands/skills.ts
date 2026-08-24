import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import { EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { discoverSkills } from '../skills/store.js'
import type { SkillInfo } from '../skills/store.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { resolveWorkingDirectory } from './run-flags.js'
import type { CommandDef } from './types.js'

interface SkillsFlags {
	readonly cwd: string | null
	readonly trust: boolean
	readonly error?: string
}

export interface SkillListItem {
	readonly name: string
	readonly description: string
	readonly source: SkillInfo['source']
	readonly path: string
	readonly usable: boolean
	readonly problem?: string
}

export interface SkillListOutput {
	readonly cwd: string
	readonly count: number
	readonly skills: readonly SkillListItem[]
	/** Human rendering selected only by TextFormatter. */
	readonly text: string
}

const HELP = [
	'Usage: namzu skills [--cwd <path>] [--trust]',
	'',
	'List user and project skills available in a working directory. Project',
	'skills shadow user skills with the same name. A broken skill remains in',
	'the list with the reason it cannot be activated.',
	'',
	'Options:',
	'  --cwd <path>  Inspect this working directory instead of the current one',
	'  --trust       Trust this directory for this invocation only',
].join('\n')

export const skillsCommand: CommandDef = {
	name: 'skills',
	description: 'List skills available to a working directory',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx: bootstrapCtx, rawArgs }) => {
		const flags = parseSkillsFlags(rawArgs)
		if (flags.error) {
			bootstrapCtx.formatter.error({ message: flags.error })
			return EXIT_USAGE
		}

		const resolved = resolveWorkingDirectory(flags.cwd)
		if ('error' in resolved) {
			bootstrapCtx.formatter.error({ message: resolved.error })
			return EXIT_USAGE
		}

		// Project skills are project files. Pin the same canonical directory the
		// trust decision admitted before reading either its config or SKILL.md.
		const trust = decideHeadlessTrust({ cwd: resolved.cwd, trustFlag: flags.trust })
		if (!trust.allowed) {
			bootstrapCtx.formatter.error({ message: trust.message })
			return EXIT_UNTRUSTED
		}

		const ctx = resolveTrustedProjectContext(bootstrapCtx, trust.cwd)
		const skills = discoverSkills({ cwd: trust.cwd }).map(toListItem)
		ctx.formatter.print({
			cwd: trust.cwd,
			count: skills.length,
			skills,
			text: renderSkillsText(trust.cwd, skills),
		} satisfies SkillListOutput)
		return 0
	},
}

function parseSkillsFlags(rawArgs: readonly string[]): SkillsFlags {
	let cwd: string | null = null
	let trust = false

	for (let index = 0; index < rawArgs.length; index++) {
		const arg = rawArgs[index]
		if (arg === '--trust') {
			trust = true
			continue
		}
		if (arg === '--cwd') {
			const value = rawArgs[index + 1]
			if (value === undefined || value.startsWith('--') || value.trim() === '') {
				return { cwd, trust, error: '--cwd requires a directory path' }
			}
			cwd = value.trim()
			index++
			continue
		}
		if (arg.startsWith('--cwd=')) {
			const value = arg.slice('--cwd='.length).trim()
			if (!value) return { cwd, trust, error: '--cwd requires a directory path' }
			cwd = value
			continue
		}
		return { cwd, trust, error: `unknown skills option or argument: ${arg}` }
	}

	return { cwd, trust }
}

function toListItem(skill: SkillInfo): SkillListItem {
	return {
		name: skill.name,
		description: skill.description,
		source: skill.source,
		path: skill.path,
		usable: skill.problem === undefined,
		...(skill.problem ? { problem: skill.problem } : {}),
	}
}

function renderSkillsText(cwd: string, skills: readonly SkillListItem[]): string {
	if (skills.length === 0) {
		return `No skills found for ${oneLine(cwd)}.`
	}

	const lines = [`Skills available for ${oneLine(cwd)} (${skills.length}):`]
	for (const skill of skills) {
		const status = skill.usable ? '' : 'unavailable · '
		lines.push(
			`  ${oneLine(skill.name)} [${skill.source}] — ${status}${oneLine(skill.description)}`,
			`    ${oneLine(skill.path)}`,
		)
		if (skill.problem) lines.push(`    reason: ${oneLine(skill.problem)}`)
	}
	return lines.join('\n')
}

function oneLine(value: string): string {
	return terminalDisplayText(value).replace(/[\t\n\r]+/g, ' ')
}
