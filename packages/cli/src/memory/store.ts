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
 * which holds structured records retrieved by tools or bounded automatic recall.
 */

import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { namzuHomePath } from '../integrations/state/home.js'
import { cliProjectRoot } from '../integrations/state/project.js'

import { type MemoryLocation, appendMemoryFile, readMemoryFile, resolveMemoryPath } from './io.js'

export { MEMORY_FILE_MAX_BYTES } from './io.js'

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

/** Share checkout memory unless this directory already owns a memory file. */
export function projectMemoryFilePath(cwd: string): string {
	let directory = resolve(cwd)
	try {
		directory = realpathSync(directory)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	const root = cliProjectRoot(directory)
	const local = join(directory, '.namzu', 'MEMORY.md')
	// An empty file or an in-scope symlink remains an intentional local file.
	if (resolveMemoryPath({ path: local, root }) !== null) return local
	return join(root, '.namzu', 'MEMORY.md')
}

export interface MemoryDiagnostic {
	readonly path: string
	readonly reason: string
}

export interface MemoryContent {
	readonly user: string | null
	readonly memory: string | null
	/** The project's own file; null when absent, empty, or refused with a diagnostic. */
	readonly project: string | null
	readonly diagnostics?: readonly MemoryDiagnostic[]
}

function projectLocation(cwd: string): MemoryLocation {
	const directory = realpathSync(resolve(cwd))
	return { path: projectMemoryFilePath(directory), root: cliProjectRoot(directory) }
}

/** Read bounded, valid UTF-8 files; distinguish missing/empty files from refused content. */
export function readMemory(home?: string, cwd?: string): MemoryContent {
	const diagnostics: MemoryDiagnostic[] = []
	const read = (path: string, location: () => MemoryLocation): string | null => {
		let selectedPath = path
		try {
			const selected = location()
			selectedPath = selected.path
			const text = readMemoryFile(selected)?.trim()
			return text || null
		} catch (error) {
			diagnostics.push({
				path: selectedPath,
				reason: error instanceof Error ? error.message : String(error),
			})
			return null
		}
	}
	const userRoot = memoryDir(home)
	const user = read(join(userRoot, 'USER.md'), () => ({
		root: userRoot,
		path: join(userRoot, 'USER.md'),
	}))
	const memory = read(join(userRoot, 'MEMORY.md'), () => ({
		root: userRoot,
		path: join(userRoot, 'MEMORY.md'),
	}))
	const project = cwd
		? read(join(resolve(cwd), '.namzu', 'MEMORY.md'), () => projectLocation(cwd))
		: null
	return { user, memory, project, ...(diagnostics.length > 0 ? { diagnostics } : {}) }
}

function capped(text: string, file: string): string {
	if (text.length <= MEMORY_SECTION_MAX_CHARS) return text
	let end = MEMORY_SECTION_MAX_CHARS
	const last = text.charCodeAt(end - 1)
	if (last >= 0xd800 && last <= 0xdbff) end -= 1
	const head = text.slice(0, end)
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
	return appendMemoryWithStatus(text, target).path
}

export interface AppendMemoryResult {
	readonly path: string
	readonly scope: MemoryScope
	readonly appended: boolean
	/** Whether the entire appended note fits in this section's next prompt snapshot. */
	readonly includedInPrompt: boolean
}

export function appendMemoryWithStatus(
	text: string,
	target?: string | AppendMemoryTarget,
): AppendMemoryResult {
	const trimmed = text.trim()
	const scope = typeof target === 'object' ? target.scope : 'user'
	const home = typeof target === 'object' ? target.home : target
	let location: MemoryLocation
	if (scope === 'project') {
		const cwd = typeof target === 'object' ? target.cwd : undefined
		if (!cwd) throw new Error('A project memory needs the working directory it belongs to.')
		location = projectLocation(cwd)
	} else {
		location = { path: memoryFilePath(home), root: memoryDir(home) }
	}
	if (trimmed.length === 0)
		return { path: location.path, scope, appended: false, includedInPrompt: false }
	const combined = appendMemoryFile(location, `- ${trimmed}\n`)
	return {
		path: location.path,
		scope,
		appended: true,
		includedInPrompt: combined.trim().length <= MEMORY_SECTION_MAX_CHARS,
	}
}
