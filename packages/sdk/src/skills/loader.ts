import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
	Skill,
	SkillDisclosureLevel,
	SkillLoadResult,
	SkillMetadata,
} from '../types/skills/index.js'
import { getRootLogger } from '../utils/logger.js'

const logger = getRootLogger().child({ component: 'SkillLoader' })

const SKILL_FILENAME = 'SKILL.md'
const FRONTMATTER_DELIMITER = '---'

interface ParsedSkillMd {
	metadata: SkillMetadata
	body: string
}

function parseSkillMd(raw: string, dirPath: string): ParsedSkillMd {
	const trimmed = raw.trimStart()

	if (!trimmed.startsWith(FRONTMATTER_DELIMITER)) {
		throw new Error(`SKILL.md at "${dirPath}" has no YAML frontmatter`)
	}

	const endIdx = trimmed.indexOf(FRONTMATTER_DELIMITER, FRONTMATTER_DELIMITER.length)
	if (endIdx === -1) {
		throw new Error(`SKILL.md at "${dirPath}" has unclosed frontmatter`)
	}

	const frontmatterRaw = trimmed.slice(FRONTMATTER_DELIMITER.length, endIdx).trim()
	const body = trimmed.slice(endIdx + FRONTMATTER_DELIMITER.length).trim()

	const metadata = parseFlatYaml(frontmatterRaw, dirPath)

	return { metadata, body }
}

function parseFlatYaml(raw: string, dirPath: string): SkillMetadata {
	const lines = raw.split('\n')
	const kv: Record<string, string> = {}

	for (const line of lines) {
		const colonIdx = line.indexOf(':')
		if (colonIdx === -1) continue
		const key = line.slice(0, colonIdx).trim()
		const value = line.slice(colonIdx + 1).trim()

		kv[key] = value.replace(/^["']|["']$/g, '')
	}

	if (!kv.name) {
		throw new Error(`SKILL.md at "${dirPath}" missing required field: name`)
	}
	if (!kv.description) {
		throw new Error(`SKILL.md at "${dirPath}" missing required field: description`)
	}

	validateSkillName(kv.name, dirPath)
	validateDescription(kv.description, dirPath)

	const metadata: SkillMetadata = {
		name: kv.name,
		description: kv.description,
	}

	if (kv.compatibility) {
		if (kv.compatibility.length > 500) {
			throw new Error(`SKILL.md at "${dirPath}": compatibility exceeds 500 characters`)
		}
		metadata.compatibility = kv.compatibility
	}

	return metadata
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
	const parsed = parseSkillMd(raw, dirPath)

	const skill: Skill = {
		metadata: parsed.metadata,
		dirPath,
	}

	if (level === 'full' || level === 'assets') {
		skill.body = parsed.body
	}

	const metadataTokens = estimateTokens(`${parsed.metadata.name}: ${parsed.metadata.description}`)
	const bodyTokens = skill.body ? estimateTokens(skill.body) : 0

	logger.debug('Loaded skill', {
		name: parsed.metadata.name,
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

	return dirs
}
