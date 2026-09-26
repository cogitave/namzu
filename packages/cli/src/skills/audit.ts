/** Static diagnostics for the file skills the CLI would discover here. */

import { dirname } from 'node:path'
import { loadSkill } from '@namzu/sdk'
import { manifestEntryChars, skillManifestBudget } from './catalog.js'
import { SKILL_TIERS, type SkillDiscoveryOptions, discoverSkillRoster } from './store.js'

export interface SkillAuditFinding {
	readonly name: string
	readonly path: string
	readonly status: 'ready' | 'operator-only' | 'disabled' | 'invalid'
	readonly reason?: string
	/** Characters this skill would add to the file-skill manifest. */
	readonly manifestChars?: number
}

export interface SkillAuditReport {
	readonly findings: readonly SkillAuditFinding[]
	readonly invalid: number
	readonly ready: number
	readonly operatorOnly: number
	readonly disabled: number
	/** Sum before the optional per-model budget is applied. */
	readonly manifestChars: number
	readonly manifestBudgetChars?: number
	readonly overflow: readonly string[]
}

/**
 * Check the exact SDK loader that serves the model, not a second copy of its
 * frontmatter rules. The ordinary roster intentionally also lists legacy
 * body-only skills an operator can activate; those are invalid for the model
 * and this audit says so without changing operator activation.
 */
export async function auditFileSkills(
	options: SkillDiscoveryOptions & { readonly contextWindowTokens?: number } = {},
): Promise<SkillAuditReport> {
	const roster = discoverSkillRoster(options).skills
	const ordered = [...roster].sort(
		(a, b) =>
			SKILL_TIERS.indexOf(b.tier) - SKILL_TIERS.indexOf(a.tier) || a.name.localeCompare(b.name),
	)
	const findings: SkillAuditFinding[] = []
	const overflow: string[] = []
	const budget =
		options.contextWindowTokens === undefined
			? undefined
			: skillManifestBudget(options.contextWindowTokens)
	let manifestChars = 0
	let admittedChars = 0

	for (const skill of ordered) {
		if (skill.disabled) {
			findings.push({ name: skill.name, path: skill.path, status: 'disabled' })
			continue
		}
		if (skill.problem) {
			findings.push({
				name: skill.name,
				path: skill.path,
				status: 'invalid',
				reason: skill.problem,
			})
			continue
		}
		try {
			const { skill: loaded } = await loadSkill(dirname(skill.path), 'metadata')
			if (loaded.metadata.invocation === 'operator') {
				findings.push({ name: skill.name, path: skill.path, status: 'operator-only' })
				continue
			}
			const chars = manifestEntryChars(loaded)
			manifestChars += chars
			if (budget !== undefined && (overflow.length > 0 || admittedChars + chars > budget))
				overflow.push(skill.name)
			else admittedChars += chars
			findings.push({
				name: skill.name,
				path: skill.path,
				status: 'ready',
				manifestChars: chars,
			})
		} catch (error) {
			findings.push({
				name: skill.name,
				path: skill.path,
				status: 'invalid',
				reason: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return {
		findings,
		invalid: findings.filter((finding) => finding.status === 'invalid').length,
		ready: findings.filter((finding) => finding.status === 'ready').length,
		operatorOnly: findings.filter((finding) => finding.status === 'operator-only').length,
		disabled: findings.filter((finding) => finding.status === 'disabled').length,
		manifestChars,
		...(budget === undefined ? {} : { manifestBudgetChars: budget }),
		overflow,
	}
}
