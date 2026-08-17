import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
	Skill,
	SkillDisclosureLevel,
	SkillLoadResult,
	SkillMetadata,
} from '../types/skills/index.js'
import { type ParsedFrontmatter, parseFrontmatter } from '../utils/frontmatter.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import { type Logger, resolveLogger } from '../utils/logger.js'

export const SKILL_FILENAME = 'SKILL.md'

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
/**
 * Read one key, narrowed to the shape this field is declared to have.
 *
 * `Object.hasOwn`, not a bare `values[key]`: a plain property read walks the
 * prototype chain, so a `Object.prototype.description` poisoned by anything
 * else in the process would be picked up here as though the file had declared
 * it. The parser can no longer create that poison; this is the other end of
 * the same guarantee.
 */
function scalarAt(values: ParsedFrontmatter['values'], key: string): string | undefined {
	if (!Object.hasOwn(values, key)) return undefined
	const found = values[key]
	return found?.kind === 'scalar' ? found.value : undefined
}

function mappingAt(
	values: ParsedFrontmatter['values'],
	key: string,
): Readonly<Record<string, string>> | undefined {
	if (!Object.hasOwn(values, key)) return undefined
	const found = values[key]
	return found?.kind === 'mapping' ? found.entries : undefined
}

function toSkillMetadata(parsed: ParsedFrontmatter, dirPath: string): SkillMetadata {
	const source = sourceLabel(dirPath)
	const { values } = parsed

	const name = scalarAt(values, 'name')
	const description = scalarAt(values, 'description')

	if (!name) {
		throw new Error(`${source} missing required field: name`)
	}
	if (!description) {
		throw new Error(`${source} missing required field: description`)
	}

	validateSkillName(name, dirPath)
	validateDescription(description, dirPath)

	const skillMetadata: SkillMetadata = { name, description }

	const license = scalarAt(values, 'license')
	if (license) {
		skillMetadata.license = license
	}

	const compatibility = scalarAt(values, 'compatibility')
	if (compatibility) {
		if (compatibility.length > 500) {
			throw new Error(`${source}: compatibility exceeds 500 characters`)
		}
		skillMetadata.compatibility = compatibility
	}

	const allowedTools = scalarAt(values, 'allowed-tools')
	if (allowedTools) {
		skillMetadata.allowedTools = allowedTools
	}

	const invocation = scalarAt(values, 'invocation')
	if (invocation) {
		// Refused rather than defaulted. A typo'd `invocaton: operator` that
		// quietly resolved to `both` would put an operator-only skill back in
		// front of the model, which is precisely what the field was added to
		// stop — and the author would have no way to tell.
		if (invocation !== 'model' && invocation !== 'operator' && invocation !== 'both') {
			throw new Error(
				`${source}: invocation must be one of model, operator, both — got "${invocation}"`,
			)
		}
		skillMetadata.invocation = invocation
	}

	const extra = mappingAt(values, 'metadata')
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
	log?: Logger,
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

	// Resolved here, not at module scope, and the reason outlived the defect
	// it was written for. A module-scope `child(...)` of a process-wide logger
	// ran once at IMPORT time and baked that moment's level in forever, which
	// no later host call could undo. LOG-20 removed the process-wide logger
	// altogether, so that particular trap is gone — and per-call resolution
	// matters more now, not less: the logger this function uses comes from its
	// own `log` parameter, and anything resolved at module scope could not see
	// it. Without a `log`, this loader emits nothing (`resolveLogger` is
	// `NOOP_LOGGER`), which is the deliberate default rather than a fallback
	// to somebody else's stream.
	const logger = resolveLogger(log).child({ [SCOPE_ATTRIBUTE]: 'skills/loader' })
	logger.debug('Loaded skill', {
		'namzu.skills.name': metadata.name,
		'namzu.skills.level': level,
		'namzu.skills.tokens': metadataTokens + bodyTokens,
	})

	return {
		skill,
		disclosureLevel: level,
		tokenEstimate: metadataTokens + bodyTokens,
	}
}

export async function discoverSkills(parentDir: string, log?: Logger): Promise<string[]> {
	// Resolved here too — see loadSkill above for why module scope froze
	// this logger's level, and its very reference, at import time.
	const logger = resolveLogger(log).child({ [SCOPE_ATTRIBUTE]: 'skills/loader' })
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
		logger.debug('Skills directory not found', { 'namzu.skills.parent_dir': parentDir })
	}

	return dirs.sort()
}
