/**
 * Skill loader — agentskills.io-style `SKILL.md` files.
 *
 * A skill is a directory containing a `SKILL.md` with YAML frontmatter
 * (`name`, `description`) and a markdown body. Skills are discovered from six
 * tiers, lowest precedence first; a later tier shadows an earlier one's skill
 * of the same name:
 *
 *   1. system:          `<package>/skills/<name>/SKILL.md` (shipped with the CLI)
 *   2. `~/.agents/skills/<name>/SKILL.md` (shared with other agents)
 *   3. `~/.namzu/skills/<name>/SKILL.md`
 *   4. legacy project:  `<cwd>/skills/<name>/SKILL.md`
 *   5. `.agents/skills/<name>/SKILL.md` in every directory from the checkout's
 *      root down to `<cwd>` (deeper wins)
 *   6. project:         `<cwd>/.namzu/skills/<name>/SKILL.md`
 *
 * The operator lists them (`/skills list`, `namzu skills`) and activates one
 * (`/skills <name>`) by injecting its body into the system prompt; the model
 * sees them through the session catalog (`catalog.ts`) and loads one with
 * the kernel's `skill` tool.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_FRONTMATTER_KEYS, parseFrontmatter } from '@namzu/sdk'
import type { SkillsConfig } from '../config/schema.js'
import { namzuHomePath } from '../integrations/state/home.js'

/** Who a skill belongs to: shipped with the CLI, the operator's, or the project's. */
export type SkillSource = 'system' | 'user' | 'project'

/** The directory family a skill was found in, lowest precedence first. */
export type SkillTier =
	| 'system'
	| 'agents-user'
	| 'user'
	| 'legacy-project'
	| 'agents-project'
	| 'project'

/** Precedence order, lowest first. A later tier shadows an earlier one. */
export const SKILL_TIERS: readonly SkillTier[] = [
	'system',
	'agents-user',
	'user',
	'legacy-project',
	'agents-project',
	'project',
]

const TIER_SOURCE: Readonly<Record<SkillTier, SkillSource>> = {
	system: 'system',
	'agents-user': 'user',
	user: 'user',
	'legacy-project': 'project',
	'agents-project': 'project',
	project: 'project',
}

export interface SkillInfo {
	readonly name: string
	readonly description: string
	readonly path: string
	readonly source: SkillSource
	/** The directory family it came from; see {@link SKILL_TIERS}. */
	readonly tier: SkillTier
	/**
	 * Why this skill cannot be used, when it cannot.
	 *
	 * A `SKILL.md` whose frontmatter does not parse is REFUSED rather than
	 * loaded with the metadata missing, but refusing it must not take the rest
	 * of the roster with it: one unreadable file in `~/.namzu/skills` would
	 * otherwise leave the operator with no skills and no reason. So it stays in
	 * the list, named, carrying the reason it is unusable. A skill named in
	 * `skills.disabled` is listed the same way.
	 */
	readonly problem?: string
	/** Named in the config's `skills.disabled`. */
	readonly disabled?: boolean
	/**
	 * `operator` when the author wrote `invocation: operator` or
	 * `disable-model-invocation: true`: the model is never offered it.
	 */
	readonly invocation?: 'model' | 'operator' | 'both'
	/** Tools the session must have for the model to be offered it (`metadata.namzu-requires-tools`). */
	readonly requiresTools?: readonly string[]
	/** Lower-precedence `SKILL.md` files of the same name this one hides. */
	readonly shadows?: readonly string[]
}

export interface SkillDiscoveryOptions {
	/** The operator's home directory; `~/.agents` and `~/.namzu` resolve under it. */
	readonly home?: string
	readonly cwd?: string
	readonly config?: SkillsConfig
	/** The system tier's directory. Defaults to the one shipped in this package. */
	readonly systemDir?: string
}

/**
 * The built-in skills shipped in this package's `skills/` directory.
 *
 * Resolved from this module's own location, so it is the same directory from
 * `src/skills/store.ts` under the test runner and from `dist/skills/store.js`
 * in an installed package — both sit two levels below the package root.
 */
export function systemSkillsDir(): string {
	return fileURLToPath(new URL('../../skills/', import.meta.url))
}

export function agentsUserSkillsDir(home?: string): string {
	return join(home ?? homedir(), '.agents', 'skills')
}

export function userSkillsDir(home?: string): string {
	return join(namzuHomePath(home), 'skills')
}

export function projectSkillsDir(cwd: string = process.cwd()): string {
	return join(cwd, '.namzu', 'skills')
}

function legacyProjectSkillsDir(cwd: string = process.cwd()): string {
	return join(cwd, 'skills')
}

/**
 * Every `.agents/skills` from the checkout's root down to `cwd`, shallowest
 * first. Outside a checkout, only `cwd`'s own.
 *
 * The root is the nearest ancestor holding a `.git` entry (a directory, or a
 * file in a worktree). Directories above it are not read: a skill in
 * `~/code/.agents/skills` belongs to no project in particular.
 */
export function agentsProjectSkillsDirs(cwd: string = process.cwd()): string[] {
	const start = resolve(cwd)
	let root: string | undefined
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, '.git'))) {
			root = dir
			break
		}
		if (dirname(dir) === dir) break
	}
	if (root === undefined) return [join(start, '.agents', 'skills')]
	const dirs = [root]
	const rest = relative(root, start)
	if (rest) {
		let current = root
		for (const part of rest.split(sep)) {
			current = join(current, part)
			dirs.push(current)
		}
	}
	return dirs.map((dir) => join(dir, '.agents', 'skills'))
}

/** The directories read, in precedence order (lowest first). */
export function skillRoots(
	opts: SkillDiscoveryOptions = {},
): { readonly tier: SkillTier; readonly dir: string }[] {
	const roots: { tier: SkillTier; dir: string }[] = []
	if (opts.config?.builtin !== false) {
		roots.push({ tier: 'system', dir: opts.systemDir ?? systemSkillsDir() })
	}
	roots.push({ tier: 'agents-user', dir: agentsUserSkillsDir(opts.home) })
	roots.push({ tier: 'user', dir: userSkillsDir(opts.home) })
	roots.push({ tier: 'legacy-project', dir: legacyProjectSkillsDir(opts.cwd) })
	for (const dir of agentsProjectSkillsDirs(opts.cwd)) roots.push({ tier: 'agents-project', dir })
	roots.push({ tier: 'project', dir: projectSkillsDir(opts.cwd) })
	return roots
}

interface ParsedSkill {
	readonly name?: string
	readonly description?: string
	readonly invocation?: 'model' | 'operator' | 'both'
	readonly requiresTools?: readonly string[]
	readonly body: string
}

const READS_SKILL_KEY = (key: string): boolean => SKILL_FRONTMATTER_KEYS.includes(key)

/**
 * Split `SKILL.md` into frontmatter (name/description) + body.
 *
 * Reads through the kernel's `parseFrontmatter`, which is the point: this file
 * used to carry its own regex, `/^---\n…\n---\n?/`, and that regex is LF-only.
 * A `SKILL.md` saved on Windows has CRLF line endings, so the match failed, the
 * whole file was treated as body, and the skill was listed under its directory
 * name with `(no description)`. It did not fail — it described the skill
 * wrongly, which is the shape that survives review.
 *
 * ## Absent frontmatter is fine; broken frontmatter is not
 *
 * These were the same case here and are not the same thing. A file with no
 * frontmatter is a documented, supported shape: the body
 * is the skill. A file that opens a fence and then fails to parse is an author
 * who tried to write metadata and got it wrong, and answering that with "no
 * metadata, carry on" put the broken YAML into the body — and from there
 * verbatim into the system prompt.
 *
 * So the fence decides. No fence, no parser: body only, exactly as documented.
 * A fence present hands the file to the kernel reader, which throws rather than
 * returning a partial result. The absence test mirrors the reader's own
 * (`raw.trimStart().startsWith('---')`) so the two cannot disagree about what
 * counts as having frontmatter — two readers disagreeing on that is the defect
 * this consolidation exists to remove.
 *
 * @param source A label for the error message, e.g. the file's path.
 * @throws When a fence is present and the frontmatter cannot be read.
 */
export function parseSkillMarkdown(raw: string, source = 'SKILL.md'): ParsedSkill {
	if (!raw.trimStart().startsWith('---')) return { body: raw.trim() }

	// The kernel loader's vocabulary: a key it does not read is skipped whole,
	// so a skill written for another agent (`argument-hint: [file]`) is not
	// refused here over a field nothing reads. `allowed-tools` may be a YAML
	// list, as the Agent Skills format writes it; the kernel's loader accepts
	// the same.
	const { values, body } = parseFrontmatter(raw, source, {
		lists: ['allowed-tools'],
		readsKey: READS_SKILL_KEY,
	})

	// A non-scalar `name` or `description` is dropped rather than rendered:
	// there is no sensible string for a block of indented pairs, and the
	// fallbacks below (directory name, "(no description)") are the honest
	// answer for a key that did not carry one.
	const name = values.name?.kind === 'scalar' ? values.name.value : undefined
	const description = values.description?.kind === 'scalar' ? values.description.value : undefined
	const declared = values.invocation?.kind === 'scalar' ? values.invocation.value : undefined
	const disableModel =
		values['disable-model-invocation']?.kind === 'scalar'
			? values['disable-model-invocation'].value
			: undefined
	const invocation =
		disableModel === 'true'
			? 'operator'
			: declared === 'model' || declared === 'operator' || declared === 'both'
				? declared
				: undefined
	const metadata = values.metadata?.kind === 'mapping' ? values.metadata.entries : undefined
	const requiresTools = parseRequiredTools(
		metadata && Object.hasOwn(metadata, 'namzu-requires-tools')
			? metadata['namzu-requires-tools']
			: undefined,
	)

	return {
		name,
		description,
		...(invocation ? { invocation } : {}),
		...(requiresTools ? { requiresTools } : {}),
		body,
	}
}

/**
 * `metadata.namzu-requires-tools`: tool names separated by commas or spaces.
 * Undefined when absent or empty.
 */
export function parseRequiredTools(declared: string | undefined): readonly string[] | undefined {
	if (declared === undefined) return undefined
	const names = declared
		.split(/[\s,]+/)
		.map((name) => name.trim())
		.filter((name) => name.length > 0)
	return names.length > 0 ? names : undefined
}

function readSkillsFrom(dir: string, tier: SkillTier): SkillInfo[] {
	const source = TIER_SOURCE[tier]
	let entries: string[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			// Hidden and `_`-prefixed entries are not skills, as in the kernel's
			// own discovery: `.gitkeep`-style placeholders and drafts stay out.
			.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
			.map((e) => e.name)
			.sort()
	} catch {
		return []
	}
	const skills: SkillInfo[] = []
	for (const dirName of entries) {
		const path = join(dir, dirName, 'SKILL.md')
		let raw: string
		try {
			raw = readFileSync(path, 'utf8')
		} catch {
			continue
		}
		let parsed: ParsedSkill
		try {
			parsed = parseSkillMarkdown(raw, path)
		} catch (err) {
			// Refused, but still listed. One unreadable file must not empty the
			// roster and leave the operator without a reason — the whole point of
			// refusing instead of degrading is that somebody gets told.
			skills.push({
				name: dirName,
				description: '(could not be read)',
				path,
				source,
				tier,
				problem: err instanceof Error ? err.message : String(err),
			})
			continue
		}
		skills.push({
			name: parsed.name ?? dirName,
			description: parsed.description ?? '(no description)',
			path,
			source,
			tier,
			...(parsed.invocation ? { invocation: parsed.invocation } : {}),
			...(parsed.requiresTools ? { requiresTools: parsed.requiresTools } : {}),
		})
	}
	return skills
}

/** Every skill found, winners and the ones they shadow. */
export interface SkillRoster {
	/** One per name: the highest-precedence tier's, sorted by name. */
	readonly skills: readonly SkillInfo[]
	/** The lower-precedence files hidden by a winner, each naming the path that hides it. */
	readonly shadowed: readonly (SkillInfo & { readonly shadowedBy: string })[]
}

/**
 * Discover every tier and resolve shadowing. A name in `skills.disabled` is
 * kept in the list, marked, with the reason it cannot be used.
 */
export function discoverSkillRoster(opts: SkillDiscoveryOptions = {}): SkillRoster {
	const disabled = new Set(opts.config?.disabled ?? [])
	const byName = new Map<string, SkillInfo[]>()
	for (const root of skillRoots(opts)) {
		for (const skill of readSkillsFrom(root.dir, root.tier)) {
			const list = byName.get(skill.name) ?? []
			list.push(skill)
			byName.set(skill.name, list)
		}
	}
	const skills: SkillInfo[] = []
	const shadowed: (SkillInfo & { shadowedBy: string })[] = []
	for (const [name, found] of byName) {
		const winner = found[found.length - 1] as SkillInfo
		const hidden = found.slice(0, -1).reverse()
		for (const lower of hidden) shadowed.push({ ...lower, shadowedBy: winner.path })
		skills.push({
			...winner,
			...(hidden.length > 0 ? { shadows: hidden.map((lower) => lower.path) } : {}),
			...(disabled.has(name)
				? {
						disabled: true,
						problem: winner.problem ?? 'disabled by skills.disabled in the config',
					}
				: {}),
		})
	}
	skills.sort((a, b) => a.name.localeCompare(b.name))
	return { skills, shadowed }
}

/**
 * Discover all skills, the highest-precedence tier winning on a name clash.
 * Returns an empty list when no skill dirs exist.
 */
export function discoverSkills(opts: SkillDiscoveryOptions = {}): SkillInfo[] {
	return [...discoverSkillRoster(opts).skills]
}

/** How a tier reads in a listing: where the file lives, in the operator's words. */
export function skillTierLabel(tier: SkillTier): string {
	switch (tier) {
		case 'system':
			return 'built-in'
		case 'agents-user':
			return '~/.agents/skills'
		case 'user':
			return '~/.namzu/skills'
		case 'legacy-project':
			return './skills'
		case 'agents-project':
			return '.agents/skills'
		case 'project':
			return './.namzu/skills'
	}
}

/** Read a skill's markdown body (frontmatter stripped). */
export function loadSkillBody(info: SkillInfo): string {
	if (info.problem) throw new Error(info.problem)
	return parseSkillMarkdown(readFileSync(info.path, 'utf8'), info.path).body
}

/** Compose the active-skills system block, or null when none are active. */
export function composeSkillsPrompt(
	active: ReadonlyArray<{ name: string; body: string }>,
): string | null {
	if (active.length === 0) return null
	const blocks = active.map((s) => `### Skill: ${s.name}\n\n${s.body}`)
	return [
		'The following skills are active for this session. Apply their guidance',
		'when relevant to the task.',
		'',
		blocks.join('\n\n'),
	].join('\n')
}

/** What `/skills` says when no tier holds a skill. */
export const NO_SKILLS_FOUND =
	'No skills found. Add one at ~/.namzu/skills/<name>/SKILL.md, ~/.agents/skills/<name>/SKILL.md or ./.agents/skills/<name>/SKILL.md.'

/**
 * `/skills list`: every skill with where it came from, what it hides, and why
 * it cannot be used when it cannot. A refused skill is shown with its reason
 * rather than hidden — dropping it silently would leave someone wondering
 * where a file they can see on disk went.
 */
export function renderSkillRoster(
	skills: readonly SkillInfo[],
	activeNames: ReadonlySet<string>,
): string {
	const lines: string[] = []
	for (const s of skills) {
		const where = skillTierLabel(s.tier)
		if (s.problem) lines.push(`! ${s.name} [${where}] — ${s.problem}`)
		else
			lines.push(`${activeNames.has(s.name) ? '● ' : '○ '}${s.name} [${where}] — ${s.description}`)
		if (s.invocation === 'operator') lines.push('    operator only: not offered to the model')
		if (s.requiresTools)
			lines.push(`    offered to the model when these tools exist: ${s.requiresTools.join(', ')}`)
		for (const hidden of s.shadows ?? []) lines.push(`    shadows ${hidden}`)
	}
	return `Skills (● active):\n  ${lines.join('\n  ')}`
}
