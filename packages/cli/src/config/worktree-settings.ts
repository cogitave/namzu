/**
 * The rules for the three worktree settings (`worktrees.branchPrefix`, `worktrees.location`,
 * `worktrees.sparseFolders`) and the one place that reads them. Each rule answers in a plain
 * sentence, so a refusal says why in the words Settings shows.
 */

import { constants, accessSync, statSync } from 'node:fs'
import { isAbsolute, posix, win32 } from 'node:path'

/** What a branch prefix is when nothing is set: a new worktree's branch is `namzu/<name>`. */
export const DEFAULT_BRANCH_PREFIX = 'namzu'

/** Names a repository keeps for its own branches; a prefix of one would collide with it. */
const PROTECTED_PREFIXES = new Set(['head', 'main', 'master'])

/** The problem with a branch prefix, or `undefined` when it is usable. */
export function branchPrefixProblem(value: string): string | undefined {
	if (value.length === 0) return 'Write a name, or clear the setting to use the default.'
	if (value.length > 40) return 'Use 40 characters or fewer.'
	if (!/^[A-Za-z0-9._-]+$/.test(value))
		return 'Use only letters, digits, dots, underscores and hyphens, with no spaces or slashes.'
	if (/^[.-]/.test(value)) return 'Start with a letter, a digit or an underscore.'
	if (value.endsWith('.') || value.includes('..') || value.endsWith('.lock'))
		return 'Git does not allow a branch name that ends with a dot or .lock, or holds two dots in a row.'
	if (PROTECTED_PREFIXES.has(value.toLowerCase()))
		return `${value} is the name of a branch your project already keeps. Pick another.`
	return undefined
}

/** The problem with how a worktree folder is written (no look at the disk), or `undefined`. */
export function worktreeLocationShapeProblem(value: string): string | undefined {
	if (value.trim().length === 0) return 'Choose a folder, or clear the setting to use the default.'
	if (value.length > 1024 || value.includes('\0')) return 'That is not a folder path.'
	if (!isAbsolute(value) && !win32.isAbsolute(value) && !posix.isAbsolute(value))
		return 'Give the full path of the folder, starting from the top of the drive.'
	return undefined
}

/** What the disk says about a worktree folder: it must exist, be a folder, and be writable. */
export function worktreeLocationProblem(value: string): string | undefined {
	const shape = worktreeLocationShapeProblem(value)
	if (shape) return shape
	let info: ReturnType<typeof statSync>
	try {
		info = statSync(value)
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === 'ENOENT'
			? 'That folder does not exist. Create it first, then choose it.'
			: 'Namzu cannot look inside that folder.'
	}
	if (!info.isDirectory()) return 'That is a file, not a folder.'
	try {
		accessSync(value, constants.W_OK)
	} catch {
		return 'Namzu cannot write to that folder. Choose one you can change.'
	}
	return undefined
}

/** The problem with one sparse folder (a path inside the repository), or `undefined`. */
export function sparseFolderProblem(value: string): string | undefined {
	const text = value.trim()
	if (text.length === 0) return 'A folder name is empty.'
	if (text.length > 512 || text.includes('\0')) return `${text.slice(0, 40)} is not a folder path.`
	if (isAbsolute(text) || win32.isAbsolute(text) || text.startsWith('/'))
		return `${text} starts from the top of the drive. Write it as a path inside the project, such as src/app.`
	if (text.startsWith('-') || text.startsWith(':') || text.startsWith('!'))
		return `${text} cannot start with that character.`
	if (text.split(/[\\/]/).some((part) => part === '..'))
		return `${text} leaves the project. Write a path inside it.`
	if (/[*?[\]]/.test(text)) return `${text} holds a wildcard. Name the folder itself.`
	return undefined
}

/** The folder as Git wants it: forward slashes, no leading `./`, no trailing slash. */
export function sparseFolderPath(value: string): string {
	return value
		.trim()
		.replaceAll('\\', '/')
		.replace(/^(\.\/)+/, '')
		.replace(/\/+$/, '')
}

/** The worktree settings in force. Unset ones are left out. */
export interface WorktreeSettings {
	readonly branchPrefix?: string
	readonly location?: string
	readonly sparseFolders?: readonly string[]
}
