import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
	Skill,
	SkillDisclosureLevel,
	SkillLoadResult,
	SkillMetadata,
} from '../types/skills/index.js'
import { type ParsedFrontmatter, parseFrontmatter } from '../utils/frontmatter.js'
import { getRootLogger } from '../utils/logger.js'

const logger = getRootLogger().child({ component: 'SkillLoader' })

const SKILL_FILENAME = 'SKILL.md'

/**
 * How this file's errors name themselves. Passed to the shared reader so a
 * frontmatter failure still reads as a `SKILL.md` failure — the reader is
 * generic, the message is not.
 */
function sourceLabel(dirPath: string): string {
	return `SKILL.md at "${dirPath}"`
}

/**
 * The skill vocabulary, applied to a generic parse.
 *
 * Splitting the file is {@link parseFrontmatter}'s job and knowing what a
 * skill requires is this function's. A command file goes through the same
 * reader and validates an entirely different set of keys.
 */
function toSkillMetadata(parsed: ParsedFrontmatter, dirPath: string): SkillMetadata {
	const source = sourceLabel(dirPath)
	const { data, blocks } = parsed

	if (!data.name) {
		throw new Error(`${source} missing required field: name`)
	}
	if (!data.description) {
		throw new Error(`${source} missing required field: description`)
	}

	validateSkillName(data.name, dirPath)
	validateDescription(data.description, dirPath)

	const skillMetadata: SkillMetadata = {
		name: data.name,
		description: data.description,
	}

	if (data.license) {
		skillMetadata.license = data.license
	}

	if (data.compatibility) {
		if (data.compatibility.length > 500) {
			throw new Error(`${source}: compatibility exceeds 500 characters`)
		}
		skillMetadata.compatibility = data.compatibility
	}

	if (data['allowed-tools']) {
		skillMetadata.allowedTools = data['allowed-tools']
	}

	// `Object.hasOwn`, not `blocks.metadata`: a bare property read walks the
	// prototype chain, so a poisoned `Object.prototype.metadata` anywhere in
	// the process would be picked up here as though the file had declared it.
	// The parser no longer creates that poison, and this is the other end of
	// the same guarantee.
	const extra = Object.hasOwn(blocks, 'metadata') ? blocks.metadata : undefined
	if (extra && Object.keys(extra).length > 0) {
		skillMetadata.metadata = { ...extra }
	}

	return skillMetadata
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function validateSkillName(name: string, dirPath: string): void {
	if (name.length > 64) {
		throw new Error(`SKILL.md at "${dirPath}": name exceeds 64 characters`)
	}
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(
			`SKILL.md at "${dirPath}": name "${name}" must be lowercase alphanumeric with hyphens, no leading/trailing hyphens, no consecutive hyphens`,
		)
	}
	const expectedName = basename(dirPath)
	if (name !== expectedName) {
		throw new Error(
			`SKILL.md at "${dirPath}": name "${name}" must match directory name "${expectedName}"`,
		)
	}
}

function validateDescription(description: string, dirPath: string): void {
	if (description.length === 0) {
		throw new Error(`SKILL.md at "${dirPath}": description must not be empty`)
	}
	if (description.length > 1024) {
		throw new Error(`SKILL.md at "${dirPath}": description exceeds 1024 characters`)
	}
}

const CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export async function loadSkill(
	dirPath: string,
	level: SkillDisclosureLevel = 'metadata',
): Promise<SkillLoadResult> {
	const skillMdPath = join(dirPath, SKILL_FILENAME)
	const raw = await readFile(skillMdPath, 'utf-8')
	const parsed = parseFrontmatter(raw, sourceLabel(dirPath))
	const metadata = toSkillMetadata(parsed, dirPath)

	const skill: Skill = {
		metadata,
		dirPath,
	}

	if (level === 'full' || level === 'assets') {
		skill.body = parsed.body
	}

	const metadataTokens = estimateTokens(`${metadata.name}: ${metadata.description}`)
	const bodyTokens = skill.body ? estimateTokens(skill.body) : 0

	logger.debug('Loaded skill', {
		name: metadata.name,
		level,
		tokens: metadataTokens + bodyTokens,
	})

	return {
		skill,
		disclosureLevel: level,
		tokenEstimate: metadataTokens + bodyTokens,
	}
}

export async function discoverSkills(parentDir: string): Promise<string[]> {
	const dirs: string[] = []

	try {
		const entries = await readdir(parentDir)
		for (const entry of entries) {
			if (entry.startsWith('.') || entry.startsWith('_')) continue
			const fullPath = join(parentDir, entry)
			const s = await stat(fullPath)
			if (!s.isDirectory()) continue

			const skillMdPath = join(fullPath, SKILL_FILENAME)
			try {
				await stat(skillMdPath)
				dirs.push(fullPath)
			} catch {}
		}
	} catch {
		logger.debug('Skills directory not found', { parentDir })
	}

	return dirs.sort()
}
