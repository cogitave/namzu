import { CHARS_PER_TOKEN } from '../constants/limits.js'
import type { WorkingStateManager } from './manager.js'
import type { WorkingState } from './types.js'

/**
 * What a compaction puts back after the summary.
 *
 * A summary says a skill was loaded and a file was read; it cannot give the
 * model the skill's steps or the file's lines, so the next step either guesses
 * from a paraphrase or loads and reads the same things again. This puts the
 * most recent of each back, verbatim, inside fixed caps — and inside a share
 * of the window, so a small window is not refilled by the thing that was meant
 * to free it.
 */

/** Skills restored per pass, most recent first. */
export const RESTORE_MAX_SKILLS = 8
/** Tokens of one restored skill. */
export const RESTORE_SKILL_TOKENS = 5_000
/** Tokens of all restored skills together. */
export const RESTORE_SKILLS_TOTAL_TOKENS = 25_000
/** Files restored per pass, most recent first. */
export const RESTORE_MAX_FILES = 5
/** Tokens of one restored file. */
export const RESTORE_FILE_TOKENS = 5_000
/** Tokens of all restored files together. */
export const RESTORE_FILES_TOTAL_TOKENS = 50_000
/** The share of the window all restored files may take. */
export const RESTORE_FILES_WINDOW_SHARE = 0.1
/** The share of the window all restored skills may take. */
export const RESTORE_SKILLS_WINDOW_SHARE = 0.05

const CUT_MARKER = '\n… [cut to fit the restore budget]'
const SKILL_CONTINUATION = /\n\n\[More skill instructions remain\.[^\]]*\]/g

function isInstructionPath(path: string): boolean {
	const normal = path.replace(/\\/g, '/')
	const name = normal.slice(normal.lastIndexOf('/') + 1)
	return name === 'AGENTS.md' || name === 'AGENTS.local.md' || normal.includes('/.namzu/rules/')
}

function isPlanPath(path: string): boolean {
	return /(^|\/)plans\/plan\.md$/.test(path.replace(/\\/g, '/'))
}

/**
 * Note a finished tool call, if it is one whose result a compaction restores.
 * Called with the call's input and the text the model was shown.
 */
export function recordRestorable(
	manager: WorkingStateManager,
	call: {
		readonly toolName: string
		readonly input: unknown
		readonly output: string
		readonly success: boolean
	},
): void {
	const input =
		typeof call.input === 'object' && call.input !== null
			? (call.input as Record<string, unknown>)
			: undefined
	if (!input) return
	if (call.toolName === 'skill') {
		if (!call.success || typeof input.name !== 'string') return
		manager.recordSkillBody(
			input.name,
			call.output.replace(SKILL_CONTINUATION, ''),
			typeof input.cursor === 'string' && input.cursor.length > 0,
		)
		return
	}
	if (call.toolName === 'read') {
		const path = typeof input.path === 'string' ? input.path : undefined
		if (!path || !call.success) return
		manager.recordFileText(path, call.output)
		return
	}
	if (call.toolName === 'write' || call.toolName === 'edit') {
		const path = typeof input.path === 'string' ? input.path : undefined
		// The body a read showed is behind the file now.
		if (path && call.success) manager.forgetFileText(path)
	}
}

function fit(text: string, tokens: number): string {
	const room = tokens * CHARS_PER_TOKEN
	return text.length <= room
		? text
		: `${text.slice(0, Math.max(0, room - CUT_MARKER.length))}${CUT_MARKER}`
}

export interface RestoreRenderOptions {
	/** The window the pass is working against; caps scale down on a small one. */
	readonly contextWindowTokens?: number
	/** A host's own line to carry across, such as where its plan file is. */
	readonly hostNote?: string
}

/** The section to append after a summary, or `undefined` when there is nothing to put back. */
export function renderRestoredContext(
	state: WorkingState,
	options: RestoreRenderOptions = {},
): string | undefined {
	const window = options.contextWindowTokens
	const skillsTotal =
		window === undefined
			? RESTORE_SKILLS_TOTAL_TOKENS
			: Math.min(RESTORE_SKILLS_TOTAL_TOKENS, Math.floor(window * RESTORE_SKILLS_WINDOW_SHARE))
	const filesTotal =
		window === undefined
			? RESTORE_FILES_TOTAL_TOKENS
			: Math.min(RESTORE_FILES_TOTAL_TOKENS, Math.floor(window * RESTORE_FILES_WINDOW_SHARE))

	const sections: string[] = []

	let skillBudget = skillsTotal
	const skills = [...(state.restorable?.skills ?? [])].reverse()
	for (const skill of skills) {
		if (sections.length >= RESTORE_MAX_SKILLS || skillBudget <= 0) break
		const body = fit(skill.body, Math.min(RESTORE_SKILL_TOKENS, skillBudget))
		skillBudget -= Math.ceil(body.length / CHARS_PER_TOKEN)
		sections.push(`### Skill: ${skill.name}\n\n${body}`)
	}

	let fileBudget = filesTotal
	let files = 0
	const candidates = [...(state.restorable?.files ?? [])].reverse()
	for (const file of candidates) {
		if (files >= RESTORE_MAX_FILES || fileBudget <= 0) break
		if (isInstructionPath(file.path) || isPlanPath(file.path)) continue
		const text = fit(file.text, Math.min(RESTORE_FILE_TOKENS, fileBudget))
		fileBudget -= Math.ceil(text.length / CHARS_PER_TOKEN)
		files += 1
		sections.push(`### File: ${file.path}\n\n${text}`)
	}

	const note = options.hostNote?.trim()
	if (note) sections.push(note)
	if (sections.length === 0) return undefined

	return [
		'## Restored after compaction',
		'',
		'These were loaded or read earlier in this conversation and are put back here so you can keep using them. A file below may have changed on disk since it was read; read it again before you rely on it for an edit.',
		'',
		sections.join('\n\n'),
	].join('\n')
}
