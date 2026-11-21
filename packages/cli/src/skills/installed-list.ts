import { type SkillTier, discoverSkillRoster, skillTierLabel } from './store.js'

/** One installed skill as Settings lists it: its name and where it lives. Nothing else. */
export interface InstalledSkill {
	readonly name: string
	readonly tier: SkillTier
	/** The tier in the person's words: `built-in`, `~/.namzu/skills`, `./.namzu/skills` and so on. */
	readonly where: string
}

/**
 * The skills the engine finds, by the same discovery the terminal app and `namzu skills list` use: the
 * built-in ones, the user's, and the project's. One entry per name (the highest tier wins). A
 * folder nobody trusted contributes no project skills. The `skills.builtin` and `skills.disabled`
 * keys are not applied: a skill that is turned off must still be listed, or it could not be
 * turned back on.
 */
export function listInstalledSkills(options: {
	readonly cwd: string
	readonly includeProject: boolean
	readonly home?: string
	/** Where the built-in skills are read from; tests point it at a folder of their own. */
	readonly systemDir?: string
}): readonly InstalledSkill[] {
	const roster = discoverSkillRoster({
		cwd: options.cwd,
		...(options.home ? { home: options.home } : {}),
		...(options.systemDir ? { systemDir: options.systemDir } : {}),
	})
	return roster.skills
		.filter((skill) => options.includeProject || skill.source !== 'project')
		.map((skill) => ({ name: skill.name, tier: skill.tier, where: skillTierLabel(skill.tier) }))
}
