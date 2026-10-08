import type { ToolResultView } from '../../types/tool/presentation.js'

const MAX = 200

type Fields = Record<string, unknown>

function fields(input: unknown): Fields {
	return input && typeof input === 'object' && !Array.isArray(input) ? (input as Fields) : {}
}

function text(value: unknown): string | undefined {
	if (typeof value === 'string') return value
	// An engine may hand a command as an argv list.
	if (Array.isArray(value) && value.every((part) => typeof part === 'string'))
		return value.join(' ')
	return undefined
}

function pick(input: Fields, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = text(input[key])?.trim()
		if (value) return value
	}
	return undefined
}

function oneLine(value: string): string {
	const line =
		value
			.split(/\r?\n/)
			.find((candidate) => candidate.trim())
			?.trim() ?? ''
	const points = Array.from(line)
	return points.length > MAX ? `${points.slice(0, MAX - 1).join('')}…` : line
}

function baseName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function humanize(name: string): string {
	// `server.tool` and `mcp__server__tool` name the tool by their last segment.
	const last = name.split(/\.|__/).filter(Boolean).pop() ?? name
	return (
		last
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.replace(/[_-]+/g, ' ')
			.trim()
			.toLowerCase() || 'tool'
	)
}

function activity(label: string): ToolResultView {
	return { kind: 'generic', label: oneLine(label), presentation: 'activity' }
}

const SHELL = new Set(['bash', 'shell', 'exec_command', 'run_command', 'local_shell', 'exec'])
const READ = new Set(['read', 'view', 'read_file'])
const EDIT = new Set(['edit', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace'])
const WRITE = new Set(['write', 'write_file'])
const SEARCH = new Set(['grep', 'glob', 'search', 'find', 'web_search', 'websearch'])
const AGENT = new Set(['task', 'agent', 'spawnagent', 'spawn_agent'])
const TASKS = new Set([
	'todowrite',
	'todo_write',
	'update_plan',
	'taskcreate',
	'taskupdate',
	'tasklist',
	'taskget',
])

/**
 * The label-only view a saved conversation keeps for an engine's own tool.
 * Engines send their own names, so this is a name map with one fallback:
 * an unknown tool is named, never called a saved action.
 */
export function engineSavedView(name: string, input: unknown): ToolResultView {
	const args = fields(input)
	const key = name.toLowerCase()
	if (SHELL.has(key)) {
		const command = pick(args, ['command', 'cmd'])
		return command
			? { kind: 'terminal', command: oneLine(command), output: '' }
			: activity('Ran command')
	}
	if (READ.has(key)) {
		const path = pick(args, ['file_path', 'path'])
		return activity(path ? `Read ${baseName(path)}` : 'Read a file')
	}
	if (EDIT.has(key)) {
		const path = pick(args, ['file_path', 'path', 'notebook_path'])
		return activity(path ? `Edited ${baseName(path)}` : 'Edited files')
	}
	if (WRITE.has(key)) {
		const path = pick(args, ['file_path', 'path'])
		return activity(path ? `Wrote ${baseName(path)}` : 'Wrote a file')
	}
	if (SEARCH.has(key)) {
		const subject = pick(args, ['pattern', 'query', 'q'])
		return activity(subject ? `Searched for ${subject}` : 'Searched')
	}
	if (AGENT.has(key)) {
		const type = pick(args, ['subagent_type', 'agent_type', 'type'])
		const about = pick(args, ['description'])
		const head = type ? `Ran agent ${type}` : 'Ran agent'
		return activity(about ? `${head} · ${about}` : head)
	}
	if (TASKS.has(key)) return activity('Updated tasks')
	return activity(`Used ${humanize(name)}`)
}
