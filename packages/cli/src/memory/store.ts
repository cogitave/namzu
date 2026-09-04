/**
 * Curated memory: the files namzu reads into every turn's prompt.
 *
 * Two scopes, three files:
 * - `~/.namzu/USER.md` — who the operator is. User scope.
 * - `~/.namzu/MEMORY.md` — facts that hold in every project. User scope.
 * - `<project>/.namzu/MEMORY.md` — facts about this repository. Project scope,
 *   and the default target of `#note` and `/memory <text>`: a note typed while
 *   working in a repository is almost always about that repository, and a
 *   memory that follows the operator into every other project is the rarer
 *   thing, asked for with `--user`.
 *
 * Each section is capped before injection. A memory file grows for months;
 * an uncapped one would spend the context every turn on the part nobody
 * curated. The cap keeps the head, says how much it left out, and the fix is
 * to edit the file — which is the whole point of a curated memory.
 *
 * Separate from the kernel's memory store (`save_memory` / `search_memory`),
 * which holds what the agent chose to keep and is searched, not injected.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { namzuHomePath } from '../integrations/state/home.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Characters of one section injected before the rest is left to the file. */
export const MEMORY_SECTION_MAX_CHARS = 8_000

export type MemoryScope = 'project' | 'user'

export function memoryDir(home?: string): string {
	return namzuHomePath(home)
}

export function userFilePath(home?: string): string {
	return join(memoryDir(home), 'USER.md')
}

export function memoryFilePath(home?: string): string {
	return join(memoryDir(home), 'MEMORY.md')
}

/** The project's memory file, inside its authored `.namzu` directory. */
export function projectMemoryFilePath(cwd: string): string {
	return join(cwd, '.namzu', 'MEMORY.md')
}

export interface MemoryContent {
	readonly user: string | null
	readonly memory: string | null
	/** The project's own file; null when no working directory was given or the file is empty. */
	readonly project: string | null
}

function readIfPresent(path: string): string | null {
	try {
		const text = readFileSync(path, 'utf8').trim()
		return text.length > 0 ? text : null
	} catch {
		return null
	}
}

/** Read the user files under `home` and, when `cwd` is given, the project file. */
export function readMemory(home?: string, cwd?: string): MemoryContent {
	return {
		user: readIfPresent(userFilePath(home)),
		memory: readIfPresent(memoryFilePath(home)),
		project: cwd ? readIfPresent(projectMemoryFilePath(cwd)) : null,
	}
}

function capped(text: string, file: string): string {
	if (text.length <= MEMORY_SECTION_MAX_CHARS) return text
	const head = text.slice(0, MEMORY_SECTION_MAX_CHARS)
	const cut = head.lastIndexOf('\n')
	const kept = cut > MEMORY_SECTION_MAX_CHARS / 2 ? head.slice(0, cut) : head
	return `${kept}\n\n(… ${text.length - kept.length} more characters in ${file} were not included; the file wants curating.)`
}

export function composeMemoryPrompt(content: MemoryContent): string | null {
	const sections: string[] = []
	if (content.user) sections.push(`## About the user\n\n${capped(content.user, 'USER.md')}`)
	if (content.memory) sections.push(`## Durable memory\n\n${capped(content.memory, 'MEMORY.md')}`)
	if (content.project) {
		sections.push(`## Project memory\n\n${capped(content.project, '.namzu/MEMORY.md')}`)
	}
	if (sections.length === 0) return null
	return [
		'The following is persistent context carried across sessions. Treat it as',
		'background knowledge about the user and prior work. Do not repeat it back',
		'verbatim unless asked.',
		'',
		sections.join('\n\n'),
	].join('\n')
}

export interface AppendMemoryTarget {
	readonly scope: MemoryScope
	readonly home?: string
	/** Required for the project scope. */
	readonly cwd?: string
}

/**
 * Append a fact as a markdown bullet, creating the file. A bare string as the
 * second argument names the application home and means the user scope.
 */
export function appendMemory(text: string, target?: string | AppendMemoryTarget): string {
	const trimmed = text.trim()
	const scope = typeof target === 'object' ? target.scope : 'user'
	const home = typeof target === 'object' ? target.home : target
	let path: string
	if (scope === 'project') {
		const cwd = typeof target === 'object' ? target.cwd : undefined
		if (!cwd) throw new Error('A project memory needs the working directory it belongs to.')
		path = projectMemoryFilePath(cwd)
	} else {
		path = memoryFilePath(home)
	}
	if (trimmed.length === 0) return path
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	appendFileSync(path, `- ${trimmed}\n`, { mode: FILE_MODE })
	return path
}
