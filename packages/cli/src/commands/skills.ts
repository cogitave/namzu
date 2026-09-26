import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import { EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { type SkillAuditReport, auditFileSkills } from '../skills/audit.js'
import { discoverSkillRoster, skillTierLabel } from '../skills/store.js'
import type { SkillInfo } from '../skills/store.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { resolveWorkingDirectory } from './exec-flags.js'
import type { CommandDef } from './types.js'

interface SkillsFlags {
	readonly cwd: string | null
	readonly trust: boolean
	readonly audit: boolean
	readonly contextWindowTokens?: number
	readonly error?: string
}

export interface SkillListItem {
	readonly name: string
	readonly description: string
	readonly source: SkillInfo['source']
	/** The directory family it came from, e.g. `agents-user` for `~/.agents/skills`. */
	readonly tier: SkillInfo['tier']
	readonly path: string
	readonly usable: boolean
	readonly problem?: string
	/** Named in `skills.disabled`. */
	readonly disabled?: boolean
	/** `operator` when the model is never offered it. */
	readonly invocation?: SkillInfo['invocation']
	/** Tools a session must have for the model to be offered it. */
	readonly requiresTools?: readonly string[]
	/** Lower-precedence `SKILL.md` files this one hides. */
	readonly shadows?: readonly string[]
}

export interface SkillListOutput {
	readonly cwd: string
	readonly count: number
	readonly skills: readonly SkillListItem[]
	/** Human rendering selected only by TextFormatter. */
	readonly text: string
}

const HELP = [
	'Usage: namzu skills [--cwd <path>] [--trust] [--audit [--context-window <tokens>]]',
	'',
	'List the skills available in a working directory: built-in, ~/.agents/skills,',
	'~/.namzu/skills, ./skills, .agents/skills (checkout root down to the',
	'directory) and ./.namzu/skills, later ones shadowing earlier ones of the',
	'same name. A broken or disabled skill remains in the list with the reason',
	'it cannot be activated.',
	'',
	'Options:',
	'  --cwd <path>  Inspect this working directory instead of the current one',
	'  --trust       Trust this directory for this invocation only',
	'  --audit       Check which skills the model can load; fail on invalid skills',
	'  --context-window <tokens>  With --audit, estimate manifest overflow for this model window',
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
		if (flags.audit) {
			const audit = await auditFileSkills({
				cwd: trust.cwd,
				...(ctx.config.skills ? { config: ctx.config.skills } : {}),
				...(flags.contextWindowTokens === undefined
					? {}
					: { contextWindowTokens: flags.contextWindowTokens }),
			})
			ctx.formatter.print({
				cwd: trust.cwd,
				...audit,
				text: renderSkillAudit(trust.cwd, audit),
			})
			return audit.invalid > 0 ? 1 : 0
		}
		const skills = discoverSkillRoster({
			cwd: trust.cwd,
			...(ctx.config.skills ? { config: ctx.config.skills } : {}),
		}).skills.map(toListItem)
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
	let audit = false
	let contextWindowTokens: number | undefined

	for (let index = 0; index < rawArgs.length; index++) {
		const arg = rawArgs[index]
		if (arg === '--trust') {
			trust = true
			continue
		}
		if (arg === '--audit') {
			audit = true
			continue
		}
		if (arg === '--context-window') {
			const value = rawArgs[index + 1]
			const parsed = value === undefined ? Number.NaN : Number(value)
			if (!Number.isSafeInteger(parsed) || parsed <= 0) {
				return { cwd, trust, audit, error: '--context-window requires a positive token count' }
			}
			contextWindowTokens = parsed
			index++
			continue
		}
		if (arg === '--cwd') {
			const value = rawArgs[index + 1]
			if (value === undefined || value.startsWith('--') || value.trim() === '') {
				return { cwd, trust, audit, error: '--cwd requires a directory path' }
			}
			cwd = value.trim()
			index++
			continue
		}
		if (arg.startsWith('--cwd=')) {
			const value = arg.slice('--cwd='.length).trim()
			if (!value) return { cwd, trust, audit, error: '--cwd requires a directory path' }
			cwd = value
			continue
		}
		return { cwd, trust, audit, error: `unknown skills option or argument: ${arg}` }
	}

	if (contextWindowTokens !== undefined && !audit) {
		return { cwd, trust, audit, error: '--context-window requires --audit' }
	}
	return { cwd, trust, audit, contextWindowTokens }
}

function renderSkillAudit(cwd: string, audit: SkillAuditReport): string {
	const lines = [`Skill audit for ${oneLine(cwd)}:`]
	for (const finding of audit.findings) {
		const suffix = finding.manifestChars === undefined ? '' : ` · ${finding.manifestChars} chars`
		lines.push(`  ${oneLine(finding.name)}: ${finding.status}${suffix}`)
		if (finding.reason) lines.push(`    ${oneLine(finding.reason)}`)
	}
	lines.push(
		`  ready: ${audit.ready}  operator-only: ${audit.operatorOnly}  disabled: ${audit.disabled}  invalid: ${audit.invalid}`,
	)
	lines.push(`  file-skill manifest: ${audit.manifestChars} potential chars`)
	if (audit.manifestBudgetChars !== undefined) {
		lines.push(`  budget for selected window: ${audit.manifestBudgetChars} chars`)
		if (audit.overflow.length > 0)
			lines.push(`  overflow: ${audit.overflow.map(oneLine).join(', ')}`)
	}
	lines.push('  Tool gating and plugin skills depend on the session and are not included.')
	return lines.join('\n')
}

function toListItem(skill: SkillInfo): SkillListItem {
	return {
		name: skill.name,
		description: skill.description,
		source: skill.source,
		tier: skill.tier,
		path: skill.path,
		usable: skill.problem === undefined,
		...(skill.problem ? { problem: skill.problem } : {}),
		...(skill.disabled ? { disabled: true } : {}),
		...(skill.invocation ? { invocation: skill.invocation } : {}),
		...(skill.requiresTools ? { requiresTools: skill.requiresTools } : {}),
		...(skill.shadows ? { shadows: skill.shadows } : {}),
	}
}

function renderSkillsText(cwd: string, skills: readonly SkillListItem[]): string {
	if (skills.length === 0) {
		return `No skills found for ${oneLine(cwd)}.`
	}

	const lines = [`Skills available for ${oneLine(cwd)} (${skills.length}):`]
	for (const skill of skills) {
		const status = skill.disabled ? 'disabled · ' : skill.usable ? '' : 'unavailable · '
		lines.push(
			`  ${oneLine(skill.name)} [${skill.source} · ${skillTierLabel(skill.tier)}] — ${status}${oneLine(skill.description)}`,
			`    ${oneLine(skill.path)}`,
		)
		if (skill.problem) lines.push(`    reason: ${oneLine(skill.problem)}`)
		if (skill.invocation === 'operator') lines.push('    operator only: not offered to the model')
		if (skill.requiresTools)
			lines.push(
				`    offered to the model when these tools exist: ${skill.requiresTools.join(', ')}`,
			)
		for (const hidden of skill.shadows ?? []) lines.push(`    shadows ${oneLine(hidden)}`)
	}
	return lines.join('\n')
}

function oneLine(value: string): string {
	return terminalDisplayText(value).replace(/[\t\n\r]+/g, ' ')
}
