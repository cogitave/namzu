/**
 * Skill loader — agentskills.io-style `SKILL.md` files.
 *
 * A skill is a directory containing a `SKILL.md` with YAML frontmatter
 * (`name`, `description`) and a markdown body. Skills are discovered from
 * two roots:
 *   - user:    `~/.namzu/skills/<name>/SKILL.md`
 *   - project: `<cwd>/skills/<name>/SKILL.md`
 *
 * Project skills shadow user skills with the same name. The TUI lists them
 * (`/skills`) and activates one (`/skill <name>`) by injecting its body
 * into the agent's system prompt for subsequent turns.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export type SkillSource = 'user' | 'project'

export interface SkillInfo {
	readonly name: string
	readonly description: string
	readonly path: string
	readonly source: SkillSource
}

export function userSkillsDir(home: string = homedir()): string {
	return join(home, '.namzu', 'skills')
}

export function projectSkillsDir(cwd: string = process.cwd()): string {
	return join(cwd, 'skills')
}

interface ParsedSkill {
	readonly name?: string
	readonly description?: string
	readonly body: string
}

/**
 * Split `SKILL.md` into frontmatter (name/description) + body. Tolerant:
 * a file with no frontmatter is all body.
 */
export function parseSkillMarkdown(raw: string): ParsedSkill {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
	if (!match) return { body: raw.trim() }
	const [, frontmatter, body] = match
	let name: string | undefined
	let description: string | undefined
	try {
		const meta = parseYaml(frontmatter ?? '') as Record<string, unknown> | null
		if (meta && typeof meta === 'object') {
			if (typeof meta.name === 'string') name = meta.name
			if (typeof meta.description === 'string') description = meta.description
		}
	} catch {
		// Malformed frontmatter → treat as no metadata; body still usable.
	}
	return { name, description, body: (body ?? '').trim() }
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
		const parsed = parseSkillMarkdown(raw)
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
	const project = readSkillsFrom(projectSkillsDir(opts.cwd), 'project')
	const byName = new Map<string, SkillInfo>()
	for (const s of user) byName.set(s.name, s)
	for (const s of project) byName.set(s.name, s) // project wins
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Read a skill's markdown body (frontmatter stripped). */
export function loadSkillBody(info: SkillInfo): string {
	return parseSkillMarkdown(readFileSync(info.path, 'utf8')).body
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
