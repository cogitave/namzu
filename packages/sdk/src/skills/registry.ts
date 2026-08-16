import type {
	Skill,
	SkillChain,
	SkillDisclosureLevel,
	SkillLoadResult,
} from '../types/skills/index.js'
import { type Logger, resolveLogger } from '../utils/logger.js'
import { discoverSkills, loadSkill } from './loader.js'

export class SkillRegistry {
	private skills = new Map<string, Skill>()
	private readonly log: Logger

	/**
	 * Bound once, at construction — not per call and not at module scope.
	 * Per-call construction (what `register`/`registerAll` did before this)
	 * still reads `getRootLogger()` on every call with no way for a caller to
	 * override it; module scope is worse still, for the reason `loadSkill`
	 * and `discoverSkills` document. A host that wants its own destination
	 * passes `log` here once.
	 */
	constructor(log?: Logger) {
		this.log = resolveLogger(log).child({ component: 'SkillRegistry' })
	}

	async register(dirPath: string, level: SkillDisclosureLevel = 'metadata'): Promise<Skill> {
		const result = await loadSkill(dirPath, level, this.log)
		this.skills.set(result.skill.metadata.name, result.skill)
		return result.skill
	}

	async registerAll(parentDir: string, level: SkillDisclosureLevel = 'metadata'): Promise<Skill[]> {
		const dirs = await discoverSkills(parentDir, this.log)
		const results: Skill[] = []

		for (const dir of dirs) {
			const skill = await this.register(dir, level)
			results.push(skill)
		}

		this.log.debug('Registered skills from directory', {
			parentDir,
			count: results.length,
			names: results.map((s) => s.metadata.name),
		})

		return results
	}

	get(name: string): Skill | undefined {
		return this.skills.get(name)
	}

	/**
	 * Register a skill already loaded, under a name the caller chose.
	 *
	 * The plugin path needs this: it namespaces a plugin's skills so two
	 * plugins shipping `reconcile` do not silently overwrite each other, and
	 * the name a skill is filed under is then not the name in its own
	 * frontmatter. `register(dirPath)` cannot express that.
	 */
	add(name: string, skill: Skill): void {
		this.skills.set(name, skill)
	}

	/**
	 * Forget one. Reports whether it was there.
	 *
	 * Needed by anything that can UNDO a registration — a plugin rollback,
	 * a plugin disable. Without it a plugin that failed halfway through
	 * enabling left its skills in the registry with nothing that could
	 * remove them, so the model kept being offered skills from a plugin the
	 * runtime had marked `error`.
	 */
	unregister(name: string): boolean {
		return this.skills.delete(name)
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

		const result = await loadSkill(existing.dirPath, level, this.log)
		this.skills.set(name, result.skill)
		return result
	}

	list(): Skill[] {
		return [...this.skills.values()]
	}

	/**
	 * Every registered name.
	 *
	 * So a lookup that misses can name what IS there. A bare "not found"
	 * sends the model guessing at spellings, and it is guessing from a
	 * manifest already in its own prompt.
	 */
	names(): readonly string[] {
		return [...this.skills.keys()]
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
	log?: Logger,
): Promise<SkillChain> {
	const categoryRegistry = new SkillRegistry(log)
	const agentRegistry = new SkillRegistry(log)

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

	resolveLogger(log)
		.child({ component: 'SkillRegistry' })
		.debug('Resolved skill chain', {
			inherited: inherited.map((s) => s.metadata.name),
			own: own.map((s) => s.metadata.name),
			resolved: resolved.map((s) => s.metadata.name),
		})

	return { inherited, own, resolved }
}
