/**
 * The hooks of the skills a conversation used, attached again when it is continued.
 *
 * A skill's hooks end with the program, but its text stays in the conversation
 * and the model goes on working under it. The conversation's own record keeps
 * which skills had hooks attached (`skill_hooks_attached`, one per use); when
 * the conversation is continued (`--continue`, the picker, a fork, a branch
 * from an earlier prompt, a session rebuilt after a model change) each of those
 * skills goes through the path a first use takes (`SkillHooksHost.restore`),
 * from the skill file as it is now, before the turn's first tool call.
 *
 * A skill whose file is gone, no longer loads, or whose folder is no longer
 * trusted is not attached, and is never silent about it: the person gets one
 * line (through the host) and the model one note (returned here).
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { SkillHooksFact } from '../integrations/sessions/conversation-facts.js'
import type { SkillHooksHost } from './skill-hooks.js'
import { parseSkillMarkdown } from './store.js'

/** The file a skill is read from, in its own folder. */
const SKILL_FILE = 'SKILL.md'

/** Whether `directory` lies inside `root` (the project folder). */
export function isInsideFolder(root: string, directory: string): boolean {
	const inside = relative(resolve(root), resolve(directory))
	return inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))
}

/** What one skill's file says now: its hooks block, or why it could not be read. */
export function readSkillNow(
	directory: string,
): { readonly hooksSource: string | undefined } | { readonly problem: string } {
	const path = join(directory, SKILL_FILE)
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		return code === 'ENOENT' || code === 'ENOTDIR'
			? { problem: `its file is gone (${path})` }
			: { problem: `its file could not be read (${path}): ${(error as Error).message}` }
	}
	try {
		return { hooksSource: parseSkillMarkdown(raw, path).hooksSource }
	} catch (error) {
		return { problem: `its file can no longer be read (${path}): ${(error as Error).message}` }
	}
}

/**
 * Attach again the hooks of every skill the conversation used. Returns what the
 * model is told about the ones that are not (all) attached; empty when all are.
 */
export function restoreSkillHooks(
	host: Pick<SkillHooksHost, 'restore'>,
	facts: readonly SkillHooksFact[],
	readNow: typeof readSkillNow = readSkillNow,
): string[] {
	const notes: string[] = []
	for (const fact of facts) {
		const note = host.restore({
			name: fact.skill,
			dirPath: fact.directory,
			now: readNow(fact.directory),
		})
		if (note !== undefined) notes.push(note)
	}
	return notes
}
