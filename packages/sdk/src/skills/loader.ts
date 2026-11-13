import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { SHELL_HOOK_EVENTS, SHELL_HOOK_PASCAL_EVENT_NAMES } from '../plugin/shell-hook.js'
import type { ReasoningEffort } from '../types/provider/chat.js'
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
 * The frontmatter keys this loader reads.
 *
 * Every other key is skipped whole, whatever YAML it is written in, so a
 * skill written for another agent — `argument-hint: [file]`, a `hooks:`
 * block, `user-invocable: false` — loads here with those fields ignored
 * instead of being refused over syntax in a field nothing reads. The keys
 * listed are still parsed strictly: a value this loader USES is never read
 * wrongly.
 */
export const SKILL_FRONTMATTER_KEYS: readonly string[] = Object.freeze([
	'name',
	'description',
	'license',
	'compatibility',
	'allowed-tools',
	'invocation',
	'disable-model-invocation',
	'metadata',
	'when_to_use',
	'context',
	'agent',
	'model',
	'effort',
	'background',
	'hooks',
])

/**
 * The keys added after other tools' skills already used them. A value in one
 * that this reader cannot take (`when_to_use: >-`, `model: [a, b]`) leaves the
 * key absent instead of refusing the skill.
 */
export const SKILL_FRONTMATTER_TOLERATED_KEYS: readonly string[] = [
	'when_to_use',
	'context',
	'agent',
	'model',
	'effort',
	'background',
]

/**
 * A hook event named at the top level of the front matter (`PreToolUse:` with
 * its list, written beside `name:` instead of under `hooks:`) is read as if it
 * had been written under `hooks:`. A guard its author wrote in the wrong place
 * is attached, not skipped as an unknown key and left to run unguarded.
 */
export const SKILL_FRONTMATTER_HOOK_EVENT_KEYS: readonly string[] = [
	...new Set([
		...(Object.values(SHELL_HOOK_PASCAL_EVENT_NAMES) as string[]),
		...SHELL_HOOK_EVENTS.filter((event) => event.includes('_')),
	]),
]

/** Keys handed back as the text the file wrote, for the host to read. */
export const SKILL_FRONTMATTER_RAW_KEYS: readonly string[] = ['hooks']

/**
 * The hooks text of a skill: the `hooks` key's block, with every hook event
 * written at the top level of the front matter moved under it. Absent when the
 * file carries none. `rawBlocks` is {@link ParsedFrontmatter.rawBlocks} read
 * with {@link SKILL_FRONTMATTER_RAW_KEYS} and {@link SKILL_FRONTMATTER_HOOK_EVENT_KEYS}.
 */
export function skillHooksSource(rawBlocks: Readonly<Record<string, string>>): string | undefined {
	const own = Object.hasOwn(rawBlocks, 'hooks') ? (rawBlocks.hooks ?? '') : ''
	const moved = SKILL_FRONTMATTER_HOOK_EVENT_KEYS.filter(
		(key) => Object.hasOwn(rawBlocks, key) && (rawBlocks[key] ?? '').trim() !== '',
	).map((key) =>
		(rawBlocks[key] ?? '')
			.split('\n')
			.map((line) => (line.trim() === '' ? line : `  ${line}`))
			.join('\n'),
	)
	if (moved.length === 0) return own.trim() === '' ? undefined : own
	return `${own.trim() === '' ? 'hooks:' : own}\n${moved.join('\n')}`
}

const READS_SKILL_KEY = (key: string): boolean => SKILL_FRONTMATTER_KEYS.includes(key)

/**
 * How this loader reads frontmatter. `allowed-tools` may be a YAML list: the
 * Agent Skills format writes it space-separated, comma-separated or as a
 * list, and all three must mean the same grant; the reader joins a list into
 * the comma form. Keys the loader does not read are skipped whole.
 */
export const SKILL_FRONTMATTER_OPTIONS = {
	lists: ['allowed-tools'],
	readsKey: READS_SKILL_KEY,
	tolerates: (key: string): boolean => SKILL_FRONTMATTER_TOLERATED_KEYS.includes(key),
	/**
	 * `hooks` is a list of mappings in a mapping, which this reader cannot
	 * hold: the host reads its text with a YAML reader (see
	 * `SkillMetadata.hooksSource`).
	 */
	raw: [...SKILL_FRONTMATTER_RAW_KEYS, ...SKILL_FRONTMATTER_HOOK_EVENT_KEYS],
} as const

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

	// The other common spelling of "the model may not pick this":
	// `disable-model-invocation: true` is `invocation: operator`. Read here,
	// at the one parser, so a registry that re-reads the file on every load
	// cannot lose it — a host-side override would be dropped by the first
	// freshness reload and the model could then load an operator-only skill.
	const disableModel = scalarAt(values, 'disable-model-invocation')
	if (disableModel !== undefined) {
		if (disableModel !== 'true' && disableModel !== 'false') {
			// Refused for the reason `invocation` is: `yes` quietly reading as
			// "not disabled" would put the skill back in front of the model.
			throw new Error(
				`${source}: disable-model-invocation must be true or false — got "${disableModel}"`,
			)
		}
		if (disableModel === 'true') {
			if (skillMetadata.invocation !== undefined && skillMetadata.invocation !== 'operator') {
				throw new Error(
					`${source}: disable-model-invocation: true contradicts invocation: ${skillMetadata.invocation}`,
				)
			}
			skillMetadata.invocation = 'operator'
		}
	}

	// The fields that shape how the skill RUNS are read leniently, the other
	// way round from the access fields above: a value this loader does not
	// understand (`effort: 5000`, `context: sideways`) leaves the skill at its
	// plain behaviour rather than refusing a skill written for another agent.
	const whenToUse = scalarAt(values, 'when_to_use')?.trim()
	if (whenToUse) skillMetadata.whenToUse = whenToUse

	if (scalarAt(values, 'context') === 'fork') skillMetadata.context = 'fork'
	const agent = scalarAt(values, 'agent')?.trim()
	if (agent) skillMetadata.agent = agent
	const model = scalarAt(values, 'model')?.trim()
	if (model && model.toLowerCase() !== 'inherit') skillMetadata.model = model
	const effort = scalarAt(values, 'effort')?.trim().toLowerCase()
	if (effort && (REASONING_EFFORTS as readonly string[]).includes(effort)) {
		skillMetadata.effort = effort as ReasoningEffort
	}
	const background = scalarAt(values, 'background')
	if (background === 'true' || background === 'false') {
		skillMetadata.background = background === 'true'
	}

	const hooksSource = skillHooksSource(parsed.rawBlocks)
	if (hooksSource !== undefined) skillMetadata.hooksSource = hooksSource

	const extra = mappingAt(values, 'metadata')
	if (extra && Object.keys(extra).length > 0) {
		skillMetadata.metadata = { ...extra }
	}

	return skillMetadata
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
]

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

/**
 * A `SKILL.md`'s text to its metadata and body, or a thrown reason.
 *
 * The one place the skill rules are applied to text. `loadSkill` reads the
 * file and calls this; a host that checks a skill without loading it (the
 * plugin validator) reads the file its own way and calls the same function,
 * so the two cannot disagree about what a valid skill is.
 *
 * @param dirPath The skill's folder: the name must match its last segment.
 */
export function parseSkillMarkdown(
	raw: string,
	dirPath: string,
): { readonly metadata: SkillMetadata; readonly body: string } {
	const parsed = parseFrontmatter(raw, sourceLabel(dirPath), SKILL_FRONTMATTER_OPTIONS)
	return { metadata: toSkillMetadata(parsed, dirPath), body: parsed.body }
}

export async function loadSkill(
	dirPath: string,
	level: SkillDisclosureLevel = 'metadata',
	log?: Logger,
): Promise<SkillLoadResult> {
	const skillMdPath = join(dirPath, SKILL_FILENAME)
	const raw = await readFile(skillMdPath, 'utf-8')
	const parsedSkill = parseSkillMarkdown(raw, dirPath)
	const metadata = parsedSkill.metadata

	const skill: Skill = {
		metadata,
		dirPath,
	}

	if (level === 'full' || level === 'assets') {
		skill.body = parsedSkill.body
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
