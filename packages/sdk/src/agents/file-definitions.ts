/**
 * Sub-agents defined in a Markdown file.
 *
 * Skills are defined this way one directory over (`skills/loader.ts`): YAML
 * frontmatter for what the thing IS, a Markdown body for what it is told.
 * An agent file is the same shape for a delegate — a name the `Agent` tool
 * can be asked for, a description the model chooses by, and optionally a
 * tool allowlist, a model and a read-only flag — so a repository can say
 * "our reviewer uses these tools and this model" once, and every host that
 * builds delegates from this kernel offers the same reviewer.
 *
 * ```md
 * ---
 * name: reviewer
 * description: Reviews a diff for correctness and convention drift.
 * tools: read, grep, glob          # optional allowlist, intersected with the parent's set
 * model: claude-sonnet-4-5         # optional override
 * readOnly: true                   # optional; keeps only read-only tools
 * ---
 * You review changes for this repository. Cite file:line for every finding …
 * ```
 *
 * `tools` is one comma-separated line: this kernel's frontmatter reader
 * refuses block lists and flow sequences by design, so there is no other
 * form to accept.
 *
 * This module decides what a file MEANS. Where files live — which
 * directories, in which order, which one shadows which — is the host's
 * decision, passed in as an ordered list of roots; later roots win. A file
 * that cannot be loaded is REPORTED with its path and reason rather than
 * silently absent, and never takes the rest of the roster with it: an
 * agent whose `tools` line failed to parse would otherwise run with the
 * parent's whole set, which is the opposite of what the line was for.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { parseFrontmatter } from '../utils/frontmatter.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import { type Logger, resolveLogger } from '../utils/logger.js'

/** Per-file character budget for the prompt body. */
export const MAX_AGENT_FILE_CHARS = 32_000

/** Bytes above which a file is not even read. */
const MAX_AGENT_FILE_BYTES = 4 * 1024 * 1024

/** The names a file may not claim by default: the delegate types a host ships. */
export const DEFAULT_RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
	'general-purpose',
	'explore',
])

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export interface AgentFileDefinition {
	readonly name: string
	readonly description: string
	/** The system prompt: the file's body, already cut to the budget. */
	readonly prompt: string
	/** Tool names the agent may use; absent means the parent's working set. */
	readonly tools?: readonly string[]
	readonly model?: string
	readonly readOnly: boolean
	readonly path: string
	/** The host's label for the root this file came from (`user`, `project`, …). */
	readonly source: string
}

export interface SkippedAgentFile {
	readonly path: string
	readonly reason: string
}

export interface AgentDefinitionRoot {
	readonly dir: string
	readonly source: string
}

export interface DiscoveredAgentDefinitions {
	/** In first-seen order; a later root's file replaces an earlier one's by name. */
	readonly definitions: readonly AgentFileDefinition[]
	readonly skipped: readonly SkippedAgentFile[]
}

export interface DiscoverAgentDefinitionsOptions {
	/** Names refused in a file. Defaults to `DEFAULT_RESERVED_AGENT_NAMES`. */
	readonly reserved?: ReadonlySet<string>
	readonly log?: Logger
}

/**
 * Every `*.md` in every root, later roots shadowing earlier ones by name.
 * A root that is not there contributes nothing; a file that is there and
 * wrong is reported.
 */
export async function discoverAgentDefinitions(
	roots: readonly AgentDefinitionRoot[],
	options: DiscoverAgentDefinitionsOptions = {},
): Promise<DiscoveredAgentDefinitions> {
	const logger = resolveLogger(options.log).child({ [SCOPE_ATTRIBUTE]: 'agents/file-definitions' })
	const byName = new Map<string, AgentFileDefinition>()
	const skipped: SkippedAgentFile[] = []
	for (const root of roots) {
		let files: string[]
		try {
			files = (await readdir(root.dir, { withFileTypes: true }))
				.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
				.map((entry) => entry.name)
				.sort()
		} catch {
			logger.debug('agent definitions directory not found', { 'namzu.agents.dir': root.dir })
			continue
		}
		for (const file of files) {
			const found = await parseAgentFile(join(root.dir, file), root.source, options.reserved)
			if ('reason' in found) skipped.push(found)
			else byName.set(found.name, found)
		}
	}
	return { definitions: [...byName.values()], skipped }
}

export async function parseAgentFile(
	path: string,
	source: string,
	reserved: ReadonlySet<string> = DEFAULT_RESERVED_AGENT_NAMES,
): Promise<AgentFileDefinition | SkippedAgentFile> {
	let raw: string
	try {
		if ((await stat(path)).size > MAX_AGENT_FILE_BYTES) {
			return { path, reason: 'is larger than 4 MiB, which no agent file is' }
		}
		raw = await readFile(path, 'utf8')
	} catch (error) {
		return {
			path,
			reason: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	return parseAgentMarkdown(raw, path, source, reserved)
}

/** Pure: the file's text to a definition, or the reason it is refused. */
export function parseAgentMarkdown(
	raw: string,
	path: string,
	source: string,
	reserved: ReadonlySet<string> = DEFAULT_RESERVED_AGENT_NAMES,
): AgentFileDefinition | SkippedAgentFile {
	if (!raw.trimStart().startsWith('---')) {
		return { path, reason: 'has no frontmatter; an agent file starts with `---` and a `name:`' }
	}
	let parsed: ReturnType<typeof parseFrontmatter>
	try {
		parsed = parseFrontmatter(raw, path)
	} catch (error) {
		return {
			path,
			reason: `frontmatter did not parse: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	const { values, body } = parsed

	const name = scalar(values.name)
	if (name === undefined) return { path, reason: 'has no `name:` in its frontmatter' }
	if (!NAME_PATTERN.test(name)) {
		return { path, reason: `\`name: ${name}\` is not a lower-case identifier (a-z, 0-9, -)` }
	}
	if (reserved.has(name)) {
		return { path, reason: `\`name: ${name}\` is a built-in type and cannot be redefined` }
	}
	const description = scalar(values.description)
	if (description === undefined || description.trim().length === 0) {
		return { path, reason: 'has no `description:`; the model chooses an agent by it' }
	}

	let tools: readonly string[] | undefined
	if (values.tools !== undefined) {
		const list = stringList(values.tools)
		if (list === undefined || list.length === 0) {
			return { path, reason: '`tools:` must be a non-empty, comma-separated list of tool names' }
		}
		tools = list
	}
	const model = scalar(values.model)
	if (values.model !== undefined && (model === undefined || model.trim().length === 0)) {
		return { path, reason: '`model:` must be a model name' }
	}
	let readOnly = false
	if (values.readOnly !== undefined) {
		const flag = scalar(values.readOnly)
		if (flag !== 'true' && flag !== 'false') {
			return { path, reason: '`readOnly:` must be true or false' }
		}
		readOnly = flag === 'true'
	}

	const trimmed = body.trim()
	if (trimmed.length === 0) {
		return { path, reason: "has an empty body; the body is the agent's system prompt" }
	}
	const prompt =
		trimmed.length > MAX_AGENT_FILE_CHARS
			? `${trimmed.slice(0, MAX_AGENT_FILE_CHARS)}\n\n[namzu: this prompt was cut at ${MAX_AGENT_FILE_CHARS} characters; ${trimmed.length - MAX_AGENT_FILE_CHARS} were omitted]`
			: trimmed

	return {
		name,
		description: description.trim(),
		prompt,
		...(tools ? { tools } : {}),
		...(model ? { model: model.trim() } : {}),
		readOnly,
		path,
		source,
	}
}

type FrontmatterValue = ReturnType<typeof parseFrontmatter>['values'][string]

function scalar(value: FrontmatterValue | undefined): string | undefined {
	return value?.kind === 'scalar' ? value.value : undefined
}

/** A comma-separated scalar; anything else is refused. */
function stringList(value: FrontmatterValue): readonly string[] | undefined {
	if (value.kind !== 'scalar') return undefined
	const text = value.value.trim()
	const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
	const items = inner
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
	return items.length > 0 ? items : undefined
}
