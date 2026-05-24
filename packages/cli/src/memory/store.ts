/**
 * Persistent memory under `~/.namzu/` — Hermes-parity flat markdown.
 *
 * - `USER.md`   — durable facts about the user (role, preferences).
 * - `MEMORY.md` — durable facts/decisions the agent should carry across
 *   sessions.
 *
 * Both are plain markdown the user and agent can read and edit. The TUI
 * injects their contents into the agent's system prompt on every turn so
 * namzu remembers across runs, and `/remember` appends to `MEMORY.md`.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export function memoryDir(home: string = homedir()): string {
	return join(home, '.namzu')
}

export function userFilePath(home: string = homedir()): string {
	return join(memoryDir(home), 'USER.md')
}

export function memoryFilePath(home: string = homedir()): string {
	return join(memoryDir(home), 'MEMORY.md')
}

export interface MemoryContent {
	readonly user: string | null
	readonly memory: string | null
}

function readIfPresent(path: string): string | null {
	try {
		const text = readFileSync(path, 'utf8').trim()
		return text.length > 0 ? text : null
	} catch {
		return null
	}
}

/** Read USER.md + MEMORY.md, returning null for absent/empty files. */
export function readMemory(home: string = homedir()): MemoryContent {
	return {
		user: readIfPresent(userFilePath(home)),
		memory: readIfPresent(memoryFilePath(home)),
	}
}

/**
 * Compose the memory system-prompt block, or `null` when there's nothing
 * to inject. The block is framed so the model treats it as background
 * knowledge, not as a user instruction for the current turn.
 */
export function composeMemoryPrompt(content: MemoryContent): string | null {
	const sections: string[] = []
	if (content.user) {
		sections.push(`## About the user\n\n${content.user}`)
	}
	if (content.memory) {
		sections.push(`## Durable memory\n\n${content.memory}`)
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

/** Append a fact to MEMORY.md as a markdown bullet, creating the file. */
export function appendMemory(text: string, home: string = homedir()): void {
	const trimmed = text.trim()
	if (trimmed.length === 0) return
	const path = memoryFilePath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	appendFileSync(path, `- ${trimmed}\n`, { mode: FILE_MODE })
}
