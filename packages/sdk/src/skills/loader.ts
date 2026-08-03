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

	// Anchored to a line of its own. An unanchored search found `---`
	// anywhere — inside a quoted value, inside a URL, inside prose — and cut
	// the frontmatter there, which both truncated the metadata AND spilled
	// the rest of the frontmatter into `body`, where it reaches the system
	// prompt verbatim.
	const closing = FRONTMATTER_FENCE.exec(trimmed.slice(FRONTMATTER_DELIMITER.length))
	if (!closing) {
		throw new Error(`SKILL.md at "${dirPath}" has unclosed frontmatter`)
	}

	const endIdx = FRONTMATTER_DELIMITER.length + closing.index
	const frontmatterRaw = trimmed.slice(FRONTMATTER_DELIMITER.length, endIdx).trim()
	const body = trimmed.slice(endIdx + closing[0].length).trim()

	const metadata = parseFlatYaml(frontmatterRaw, dirPath)

	return { metadata, body }
}

function parseFlatYaml(raw: string, dirPath: string): SkillMetadata {
	const lines = raw.split('\n')
	const kv: Record<string, string> = {}
	const metadata: Record<string, string> = {}
	let section: 'metadata' | undefined

	for (const line of lines) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue

		if (/^\s/.test(line)) {
			if (section !== 'metadata') continue
			const colonIdx = line.indexOf(':')
			if (colonIdx === -1) continue
			const key = line.slice(0, colonIdx).trim()
			const value = normalizeYamlScalar(line.slice(colonIdx + 1).trim())
			if (key && value) metadata[key] = value
			continue
		}

		const colonIdx = line.indexOf(':')
		if (colonIdx === -1) continue
		const key = line.slice(0, colonIdx).trim()
		const value = normalizeYamlScalar(line.slice(colonIdx + 1).trim())

		assertReadableScalar(key, value, dirPath)

		section = key === 'metadata' ? 'metadata' : undefined
		if (value) kv[key] = value
	}

	if (!kv.name) {
		throw new Error(`SKILL.md at "${dirPath}" missing required field: name`)
	}
	if (!kv.description) {
		throw new Error(`SKILL.md at "${dirPath}" missing required field: description`)
	}

	validateSkillName(kv.name, dirPath)
	validateDescription(kv.description, dirPath)

	const skillMetadata: SkillMetadata = {
		name: kv.name,
		description: kv.description,
	}

	if (kv.license) {
		skillMetadata.license = kv.license
	}

	if (kv.compatibility) {
		if (kv.compatibility.length > 500) {
			throw new Error(`SKILL.md at "${dirPath}": compatibility exceeds 500 characters`)
		}
		skillMetadata.compatibility = kv.compatibility
	}

	if (kv['allowed-tools']) {
		skillMetadata.allowedTools = kv['allowed-tools']
	}

	if (Object.keys(metadata).length > 0) {
		skillMetadata.metadata = metadata
	}

	return skillMetadata
}

function normalizeYamlScalar(value: string): string {
	return value.replace(/^["']|["']$/g, '').trim()
}

/** A closing fence is a line of its own, not `---` wherever it appears. */
const FRONTMATTER_FENCE = /^---[ \t]*$/m

/**
 * YAML this reader does not implement, refused rather than mangled.
 *
 * The frontmatter reader here is a flat key/value splitter, and the
 * documented contract says "YAML frontmatter" with no restriction — so an
 * author has every reason to write a block scalar or a flow sequence, and
 * no reason to expect what happened next. A `description: >-` followed by
 * an indented paragraph produced the literal string `">-"`, which passed
 * validation and registered with no warning; the skill then existed and
 * was never selected, because its description said nothing. A
 * `[Read, Grep]` became that literal text and was interpolated straight
 * into the prompt.
 *
 * Refusing names the line and the file. That is worse for exactly one
 * skill — the one already silently broken — and better for everyone
 * looking for it.
 */
const UNSUPPORTED_YAML = [
	{ pattern: /^[>|][-+]?\s*$/, what: 'a block scalar (`>` or `|`)' },
	{ pattern: /^\[.*\]$/, what: 'a flow sequence (`[a, b]`)' },
	{ pattern: /^\{.*\}$/, what: 'a flow mapping (`{a: b}`)' },
] as const

function assertReadableScalar(key: string, rawValue: string, dirPath: string): void {
	const value = rawValue.trim()
	for (const { pattern, what } of UNSUPPORTED_YAML) {
		if (!pattern.test(value)) continue
		throw new Error(
			`SKILL.md at "${dirPath}": "${key}" uses ${what}, which this reader does not support. Write it as a single-line value instead. Refusing rather than registering a skill whose "${key}" would read as ${JSON.stringify(value)}.`,
		)
	}
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

	return dirs.sort()
}
