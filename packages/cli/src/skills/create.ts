/**
 * `namzu skills create`: the same validators and the same writer as `skills add`,
 * from flags. No model is involved. It exists so a form, a script and a test can
 * make a skill the way the file path does.
 */

import {
	type InstallContext,
	type PreparedSkill,
	type SkillOutcome,
	installPrepared,
} from './add.js'
import { digestFiles } from './install.js'
import { composeSkillMarkdown } from './save.js'
import { SkillDraftError, validateSkillDraft } from './validate.js'

export const LEADING_FRONTMATTER_MESSAGE =
	'Your instructions start with a --- block. Remove it: the name and description become the frontmatter.'

/** The instructions the person typed must not carry a frontmatter of their own. */
export function startsWithFrontmatter(instructions: string): boolean {
	return /^﻿?\s*---[ \t]*(\r?\n|$)/.test(instructions)
}

export interface CreateInput {
	readonly name: string
	readonly description: string
	readonly instructions: string
}

/** Check the three fields and build the skill. Throws {@link SkillDraftError} with a sentence for the person. */
export function prepareCreatedSkill(input: CreateInput, now: Date): PreparedSkill {
	if (startsWithFrontmatter(input.instructions))
		throw new SkillDraftError(LEADING_FRONTMATTER_MESSAGE)
	const draft = validateSkillDraft({
		name: input.name,
		description: input.description,
		body: input.instructions,
		origin: 'created',
		rejectMarkup: true,
	})
	const markdown = composeSkillMarkdown(draft, { createdAt: now })
	const bytes = Buffer.from(markdown, 'utf8')
	const files = new Map([['SKILL.md', { bytes, executable: false }]])
	return {
		name: draft.name,
		description: draft.description,
		markdown,
		files,
		source: 'create',
		fileName: 'namzu skills create',
		sha256: digestFiles(files),
		findings: [],
		consent: [],
	}
}

/** Create a skill from flags. */
export async function createSkill(input: CreateInput, ctx: InstallContext): Promise<SkillOutcome> {
	let prepared: PreparedSkill
	try {
		prepared = prepareCreatedSkill(input, (ctx.now ?? (() => new Date()))())
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error)
		return {
			input: input.name,
			status: 'failed',
			message: text.charAt(0).toUpperCase() + text.slice(1),
			findings: [],
			notes: [],
		}
	}
	return installPrepared(prepared, input.name, ctx)
}
