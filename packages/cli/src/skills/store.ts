/**
 * Skill loader — agentskills.io-style `SKILL.md` files.
 *
 * A skill is a directory containing a `SKILL.md` with YAML frontmatter
 * (`name`, `description`) and a markdown body. Skills are discovered from
 * two roots:
 *   - user:    `~/.namzu/skills/<name>/SKILL.md`
 *   - project: `<cwd>/.namzu/skills/<name>/SKILL.md`
 *   - legacy project: `<cwd>/skills/<name>/SKILL.md`
 *
 * Project skills shadow user skills with the same name. The TUI lists them
 * (`/skills`) and activates one (`/skill <name>`) by injecting its body
 * into the agent's system prompt for subsequent turns.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '@namzu/sdk'
import { namzuHomePath } from '../integrations/state/home.js'

export type SkillSource = 'user' | 'project'

export interface SkillInfo {
	readonly name: string
	readonly description: string
	readonly path: string
	readonly source: SkillSource
	/**
	 * Why this skill cannot be used, when it cannot.
	 *
	 * A `SKILL.md` whose frontmatter does not parse is REFUSED rather than
	 * loaded with the metadata missing, but refusing it must not take the rest
	 * of the roster with it: one unreadable file in `~/.namzu/skills` would
	 * otherwise leave the operator with no skills and no reason. So it stays in
	 * the list, named, carrying the reason it is unusable.
	 */
	readonly problem?: string
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

interface ParsedSkill {
	readonly name?: string
	readonly description?: string
	readonly body: string
}

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

	const { values, body } = parseFrontmatter(raw, source)

	// A non-scalar `name` or `description` is dropped rather than rendered:
	// there is no sensible string for a block of indented pairs, and the
	// fallbacks below (directory name, "(no description)") are the honest
	// answer for a key that did not carry one.
	const name = values.name?.kind === 'scalar' ? values.name.value : undefined
	const description = values.description?.kind === 'scalar' ? values.description.value : undefined

	return { name, description, body }
}

function readSkillsFrom(dir: string, source: SkillSource): SkillInfo[] {
	let entries: string[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
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
				problem: err instanceof Error ? err.message : String(err),
			})
			continue
		}
		skills.push({
			name: parsed.name ?? dirName,
			description: parsed.description ?? '(no description)',
			path,
			source,
		})
	}
	return skills
}

/**
 * Discover all skills, project shadowing user on name clash. Returns an
 * empty list when no skill dirs exist.
 */
export function discoverSkills(opts: { home?: string; cwd?: string } = {}): SkillInfo[] {
	const user = readSkillsFrom(userSkillsDir(opts.home), 'user')
	const legacyProject = readSkillsFrom(legacyProjectSkillsDir(opts.cwd), 'project')
	const project = readSkillsFrom(projectSkillsDir(opts.cwd), 'project')
	const byName = new Map<string, SkillInfo>()
	for (const s of user) byName.set(s.name, s)
	for (const s of legacyProject) byName.set(s.name, s)
	for (const s of project) byName.set(s.name, s) // project wins
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
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
