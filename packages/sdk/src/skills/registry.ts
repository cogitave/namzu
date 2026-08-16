import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
	Skill,
	SkillChain,
	SkillDisclosureLevel,
	SkillLoadResult,
} from '../types/skills/index.js'
import { type Logger, resolveLogger } from '../utils/logger.js'

import { SKILL_FILENAME, discoverSkills, loadSkill } from './loader.js'

/**
 * What the file looked like when we read it.
 *
 * mtime AND size, not mtime alone. Coarse-grained filesystem timestamps —
 * one-second resolution is still common on network mounts, and some
 * container layers are worse — make two edits within one tick
 * indistinguishable by mtime. Size catches most of what mtime misses, and
 * the remainder is stated rather than papered over: an edit that changes
 * neither, inside one timestamp tick, is not detected. Hashing the file
 * would catch it and would mean reading every skill on every lookup, which
 * is the cost this check exists to avoid.
 */
interface FileStamp {
	readonly path: string
	readonly mtimeMs: number
	readonly size: number
}

export class SkillRegistry {
	private skills = new Map<string, Skill>()
	private stamps = new Map<string, FileStamp>()
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
		await this.stamp(result.skill.metadata.name, dirPath)
		return result.skill
	}

	/** Record what the file looked like, so a later read can tell it changed. */
	private async stamp(name: string, dirPath: string): Promise<void> {
		const path = join(dirPath, SKILL_FILENAME)
		try {
			const info = await stat(path)
			this.stamps.set(name, { path, mtimeMs: info.mtimeMs, size: info.size })
		} catch {
			// A skill that was just read and whose file cannot now be stat'ed
			// is a race with somebody editing it. Leaving no stamp means the
			// next lookup treats it as changed and re-reads — which is the
			// right answer, and strictly better than recording a stamp we
			// could not take.
			this.stamps.delete(name)
		}
	}

	async registerAll(parentDir: string, level: SkillDisclosureLevel = 'metadata'): Promise<Skill[]> {
		const dirs = await discoverSkills(parentDir, this.log)
		const results: Skill[] = []

		for (const dir of dirs) {
			const skill = await this.register(dir, level)
			results.push(skill)
		}

		this.log.debug('Registered skills from directory', {
			'namzu.skills.parent_dir': parentDir,
			'namzu.skills.count': results.length,
			'namzu.skills.names': results.map((s) => s.metadata.name),
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
		// Deliberately NOT stamped. `add` is synchronous by contract, and a
		// fire-and-forget `stat` here would be a promise nothing awaits
		// racing the first `load` — sometimes stamped, sometimes not,
		// depending on scheduling. Unstamped is treated as changed, so the
		// first `load` re-reads: one extra read, never a stale answer, and no
		// race to reason about.
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
		this.stamps.delete(name)
		return this.skills.delete(name)
	}

	/**
	 * Load a skill, re-reading it if the file changed since we last did.
	 *
	 * The cache was permanent: once a body had been read, `existing.body`
	 * short-circuited every later call, so an edited SKILL.md could not reach
	 * the model without restarting the process. That is fine for a run and
	 * wrong for a long-lived one — a skill is a file an author is editing
	 * WHILE the agent is running, which is the whole reason it is a file and
	 * not a constant.
	 *
	 * One `stat` per lookup, not a hash and not a watcher. A watcher is a
	 * resource with a lifetime, and this registry has no teardown to hang one
	 * on; a hash means reading every skill on every lookup, which is the cost
	 * the cache exists to avoid.
	 */
	async load(
		name: string,
		level: SkillDisclosureLevel = 'full',
	): Promise<SkillLoadResult | undefined> {
		const existing = this.skills.get(name)
		if (!existing) return undefined

		const changed = await this.hasChanged(name, existing.dirPath)
		if (changed === 'gone') {
			// Dropped, not served stale. A skill whose file was deleted is a
			// skill that no longer exists, and answering with its last known
			// body hands the model instructions for something nobody can point
			// at. Removing the name keeps the manifest and this lookup
			// agreeing, which they would not if one listed it and the other
			// refused.
			this.skills.delete(name)
			this.stamps.delete(name)
			this.log.info('Skill removed: its SKILL.md is gone', { 'namzu.skill.name': name })
			return undefined
		}

		if (changed === 'same' && (level === 'metadata' || existing.body)) {
			return {
				skill: existing,
				disclosureLevel: existing.body ? 'full' : 'metadata',
				tokenEstimate: 0,
			}
		}

		const result = await loadSkill(existing.dirPath, level, this.log)
		// Keyed by the name it was REGISTERED under, not by what the reloaded
		// file now says. The plugin path files skills under `plugin__skill`
		// while the file says `skill`, so taking the name off disk would
		// silently un-namespace them — the old key would point at nothing and
		// a new one would appear that nothing in the prompt has heard of.
		//
		// The SAME object is stored and returned. Returning `result` while
		// caching a re-keyed copy handed the caller the on-disk name and the
		// registry the registered one, which is the divergence this re-keying
		// exists to prevent, reintroduced one line below the comment saying
		// so.
		const rekeyed: Skill = { ...result.skill, metadata: { ...result.skill.metadata, name } }
		this.skills.set(name, rekeyed)
		await this.stamp(name, existing.dirPath)
		return { ...result, skill: rekeyed }
	}

	/** `same`, `changed`, or `gone`. */
	private async hasChanged(name: string, dirPath: string): Promise<'same' | 'changed' | 'gone'> {
		const previous = this.stamps.get(name)
		const path = previous?.path ?? join(dirPath, SKILL_FILENAME)
		let info: Awaited<ReturnType<typeof stat>>
		try {
			info = await stat(path)
		} catch {
			return 'gone'
		}
		// Unstamped is CHANGED, not unchanged. A skill put in by `add` has no
		// stamp, and reading it as unchanged would serve whatever the caller
		// handed over forever — which for the plugin path is a body read at
		// enable time and never again.
		if (!previous) return 'changed'
		return info.mtimeMs === previous.mtimeMs && info.size === previous.size ? 'same' : 'changed'
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
			'namzu.skills.inherited': inherited.map((s) => s.metadata.name),
			'namzu.skills.own': own.map((s) => s.metadata.name),
			'namzu.skills.resolved': resolved.map((s) => s.metadata.name),
		})

	return { inherited, own, resolved }
}
