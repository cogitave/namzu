/**
 * What a host that draws its own confirmation (the desktop app) is told about a `save_skill`
 * call: the same facts the terminal screen is drawn from ({@link SaveSkillRequest}), as plain
 * JSON. The host computes every field; nothing here is the model's own wording, except the
 * skill's name, description and file, which the person is shown to approve.
 */

import type { HostCommandDescriptor } from '@namzu/sdk'

import {
	type SaveSkillRequest,
	type SkillSaveScope,
	describeCollision,
	newSkillPrompt,
} from './save.js'

/** One place the skill could be saved to. */
export interface SkillSaveCardTarget {
	readonly scope: SkillSaveScope
	/** The `SKILL.md` as the person would type it (`~/…`, `./…`). */
	readonly path: string
	/** What saving here does to a skill that already has this name; empty when nothing does. */
	readonly shadows: readonly string[]
}

/** The payload of the desktop's skill-save card. */
export interface SkillSaveCardPayload {
	readonly name: string
	readonly description: string
	/** The whole file, with invisible and control characters shown as `<U+XXXX>`. */
	readonly file: string
	/** True when the file holds characters the person could not see unless they were shown. */
	readonly hiddenCharacters: boolean
	readonly warnings: readonly string[]
	/** Where the model suggested the skill go; the card marks it and preselects nothing. */
	readonly suggested: SkillSaveScope
	readonly targets: readonly [SkillSaveCardTarget, SkillSaveCardTarget]
	/** True when either target would replace, or be hidden by, an existing skill. */
	readonly shadowsExisting: boolean
}

export const SKILL_SAVE_QUESTION_ID = 'skill-save'
/** The option ids of the card's one question; anything else is a cancel. */
export const SKILL_SAVE_OPTIONS = ['user', 'project', 'cancel'] as const

export function skillSaveCardPayload(request: SaveSkillRequest, cwd: string): SkillSaveCardPayload {
	const target = (scope: SkillSaveScope): SkillSaveCardTarget => {
		const planned = request.targets[scope]
		return {
			scope,
			path: planned.displayPath,
			shadows: planned.collisions.map((collision) => describeCollision(collision, cwd)),
		}
	}
	const targets = [target('user'), target('project')] as const
	return {
		name: request.draft.name,
		description: request.draft.description,
		file: request.revealed,
		hiddenCharacters: request.revealed !== request.markdown,
		warnings: request.warnings,
		suggested: request.suggested,
		targets,
		shadowsExisting: targets.some((entry) => entry.shadows.length > 0),
	}
}

/**
 * `/skills new [idea]` as the app's composer offers it (the terminal keeps its own, richer
 * `/skills`): it answers with the prompt that starts the skill-creator interview. The spelling
 * is keywords, `skills new`, never a hyphenated name.
 */
export const SKILLS_HOST_COMMAND: HostCommandDescriptor = {
	name: 'skills',
	description:
		'Create a skill: Namzu interviews you, shows the draft, and saves it after you confirm.',
	hint: 'new [what the skill should do]',
	args: {
		type: 'object',
		properties: { words: { type: 'array', items: { type: 'string' } } },
	},
	handler: ({ args }) => {
		if (args[0] !== 'new') return { kind: 'refused', reason: 'Say "skills new" to create a skill.' }
		return { kind: 'prompt', text: newSkillPrompt(args.slice(1).join(' ')) }
	},
}
