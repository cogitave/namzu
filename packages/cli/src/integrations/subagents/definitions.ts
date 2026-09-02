/**
 * Sub-agents a project or a user defines in a file.
 *
 * `~/.namzu/agents/<name>.md` and `<cwd>/.namzu/agents/<name>.md`, the way
 * skills are defined one directory over: YAML frontmatter for what the agent
 * IS, a Markdown body for what it is told. The two built-in types
 * (`general-purpose`, `explore`) cover "do this" and "find this"; a file is
 * how a repository says "our reviewer uses these tools and this model" once,
 * so every operator delegates to the same reviewer rather than typing a
 * `role` each time and getting a different one.
 *
 * ```md
 * ---
 * name: reviewer
 * description: Reviews a diff for correctness and convention drift.
 * tools: read, grep, glob        # optional allowlist, intersected with the parent's set
 * model: claude-sonnet-4-5       # optional override
 * readOnly: true                 # optional; keeps only read-only tools, like explore
 * ---
 * You review changes for this repository. Cite file:line for every finding …
 * ```
 *
 * Project files shadow user files with the same name, and both are refused
 * — listed with a reason — rather than loaded with a field missing: an agent
 * whose `tools` line failed to parse would otherwise run with the parent's
 * whole set, which is the opposite of what the line was for. A name that
 * collides with a built-in type is refused too; `explore` is the kernel's
 * word for read-only and a file cannot redefine it.
 *
 * Bounded like the instructions file: one file is cut at
 * `MAX_AGENT_FILE_CHARS`, and the cut is reported.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseFrontmatter } from '@namzu/sdk'

import { namzuHomePath } from '../state/home.js'

export type AgentDefinitionSource = 'user' | 'project'

/** Per-file character budget for the prompt body. */
export const MAX_AGENT_FILE_CHARS = 32_000

/** Names a file may not claim: the built-in types the kernel already owns. */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(['general-purpose', 'explore'])

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
	readonly source: AgentDefinitionSource
}

export interface SkippedAgentFile {
	readonly path: string
	readonly reason: string
}

export interface DiscoveredAgentDefinitions {
	readonly definitions: readonly AgentFileDefinition[]
	readonly skipped: readonly SkippedAgentFile[]
}

export function userAgentsDir(home?: string): string {
	return join(namzuHomePath(home), 'agents')
}

export function projectAgentsDir(cwd: string): string {
	return join(cwd, '.namzu', 'agents')
}

/**
 * Both directories, project shadowing user. A directory that is not there
 * contributes nothing; a file that is there and wrong is reported.
 */
export function discoverAgentDefinitions(opts: {
	readonly cwd: string
	readonly home?: string
}): DiscoveredAgentDefinitions {
	const byName = new Map<string, AgentFileDefinition>()
	const skipped: SkippedAgentFile[] = []
	// User first, then project, so a project file replaces a user one.
	for (const [dir, source] of [
		[userAgentsDir(opts.home), 'user'],
		[projectAgentsDir(opts.cwd), 'project'],
	] as const) {
		for (const found of readAgentsFrom(dir, source)) {
			if ('reason' in found) skipped.push(found)
			else byName.set(found.name, found)
		}
	}
	return { definitions: [...byName.values()], skipped }
}

function readAgentsFrom(
	dir: string,
	source: AgentDefinitionSource,
): Array<AgentFileDefinition | SkippedAgentFile> {
	let entries: string[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
			.map((entry) => entry.name)
			.sort()
	} catch {
		return []
	}
	return entries.map((file) => parseAgentFile(join(dir, file), source))
}

export function parseAgentFile(
	path: string,
	source: AgentDefinitionSource,
): AgentFileDefinition | SkippedAgentFile {
	let raw: string
	try {
		if (statSync(path).size > 4 * 1024 * 1024) {
			return { path, reason: 'is larger than 4 MiB, which no agent file is' }
		}
		raw = readFileSync(path, 'utf8')
	} catch (error) {
		return {
			path,
			reason: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	return parseAgentMarkdown(raw, path, source)
}

/** Pure: the file's text to a definition, or the reason it is refused. */
export function parseAgentMarkdown(
	raw: string,
	path: string,
	source: AgentDefinitionSource,
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
	if (RESERVED_AGENT_NAMES.has(name)) {
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
			return { path, reason: '`tools:` must be a non-empty list of tool names' }
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

/**
 * A comma-separated scalar (`tools: read, grep, glob`); anything else is
 * refused. The kernel's frontmatter reader knows scalars and one level of
 * mapping — it refuses block lists and flow sequences by design — so the
 * allowlist is written as one line, the form the example at the top shows.
 */
function stringList(value: FrontmatterValue): readonly string[] | undefined {
	if (value.kind === 'scalar') {
		const text = value.value.trim()
		const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
		const items = inner
			.split(',')
			.map((item) => item.trim())
			.filter((item) => item.length > 0)
		return items.length > 0 ? items : undefined
	}
	return undefined
}
