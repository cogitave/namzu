import type {
	Skill,
	SkillChain,
	SkillDisclosureLevel,
	SkillLoadResult,
} from '../types/skills/index.js'
import { getRootLogger } from '../utils/logger.js'
import { discoverSkills, loadSkill } from './loader.js'

export class SkillRegistry {
	private skills = new Map<string, Skill>()

	async register(dirPath: string, level: SkillDisclosureLevel = 'metadata'): Promise<Skill> {
		const result = await loadSkill(dirPath, level)
		this.skills.set(result.skill.metadata.name, result.skill)
		return result.skill
	}

	async registerAll(parentDir: string, level: SkillDisclosureLevel = 'metadata'): Promise<Skill[]> {
		const dirs = await discoverSkills(parentDir)
		const results: Skill[] = []

		for (const dir of dirs) {
			const skill = await this.register(dir, level)
			results.push(skill)
		}

		// Resolved here, not at module scope. A module-scope
		// `getRootLogger().child(...)` ran once, at import time — before any
		// host's `configureLogger()` call had a chance to run — and `child()`
		// bakes `minLevel` into the closure `log()` reads from forever after
		// (`utils/logger.ts`), so whatever level was live at that one moment
		// was permanent. `configureLogger` replaces the `_rootLogger` binding
		// rather than mutating the object it points at, so caching the CHILD
		// (as this registry did) survives no later call at all — including
		// the CLI's own `configureLogger({ level: 'silent' })`.
		const logger = getRootLogger().child({ component: 'SkillRegistry' })
		logger.debug('Registered skills from directory', {
			parentDir,
			count: results.length,
			names: results.map((s) => s.metadata.name),
		})

		return results
	}

	get(name: string): Skill | undefined {
		return this.skills.get(name)
	}

	async load(
		name: string,
		level: SkillDisclosureLevel = 'full',
	): Promise<SkillLoadResult | undefined> {
		const existing = this.skills.get(name)
		if (!existing) return undefined

		if (level === 'metadata' || existing.body) {
			return {
				skill: existing,
				disclosureLevel: existing.body ? 'full' : 'metadata',
				tokenEstimate: 0,
			}
		}

		const result = await loadSkill(existing.dirPath, level)
		this.skills.set(name, result.skill)
		return result
	}

	list(): Skill[] {
		return [...this.skills.values()]
	}

	get size(): number {
		return this.skills.size
	}

	has(name: string): boolean {
		return this.skills.has(name)
	}
}

export async function resolveSkillChain(
	categorySkillsDir: string | undefined,
	agentSkillsDir: string | undefined,
	level: SkillDisclosureLevel = 'metadata',
): Promise<SkillChain> {
	const categoryRegistry = new SkillRegistry()
	const agentRegistry = new SkillRegistry()

	const inherited = categorySkillsDir
		? await categoryRegistry.registerAll(categorySkillsDir, level)
		: []

	const own = agentSkillsDir ? await agentRegistry.registerAll(agentSkillsDir, level) : []

	const resolvedMap = new Map<string, Skill>()

	for (const skill of inherited) {
		resolvedMap.set(skill.metadata.name, skill)
	}
	for (const skill of own) {
		resolvedMap.set(skill.metadata.name, skill)
	}

	const resolved = [...resolvedMap.values()]

	// Resolved here too — see registerAll above for why module scope froze
	// this logger's level, and its very reference, at import time.
	const logger = getRootLogger().child({ component: 'SkillRegistry' })
	logger.debug('Resolved skill chain', {
		inherited: inherited.map((s) => s.metadata.name),
		own: own.map((s) => s.metadata.name),
		resolved: resolved.map((s) => s.metadata.name),
	})

	return { inherited, own, resolved }
}
