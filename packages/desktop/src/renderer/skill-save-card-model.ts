import {
	type QuestionResponse,
	SKILL_SAVE_QUESTION_ID,
	type SkillSaveCard,
	type SkillSaveChoice,
} from '../shared/question-protocol.js'

/**
 * What the skill-save card says, as plain values: no React and no clock, so the wording and the
 * rules can be tested on their own. The host computed the file, the places and what each would
 * replace; the card only words them.
 */

/** How many lines of the file the card shows before "Show all". */
export const SKILL_PREVIEW_LINES = 14

export const SKILL_SAVE_LABELS: Readonly<Record<SkillSaveChoice, string>> = {
	user: 'Save to my skills',
	project: 'Save to this project',
	cancel: 'Cancel',
}

export interface SkillSaveTargetView {
	scope: 'user' | 'project'
	label: string
	/** Where the file would be written, as the person would type it. */
	path: string
	/** What saving here would replace or lose to, in one sentence each. */
	notes: string[]
	suggested: boolean
}

export interface SkillSaveView {
	title: string
	description: string
	/** The first lines of the file, or all of it when expanded or short. */
	preview: string
	/** Lines the preview leaves out; 0 once everything shows. */
	hiddenLines: number
	canExpand: boolean
	targets: SkillSaveTargetView[]
	/** True when a target would replace, or lose to, a skill of the same name. */
	shadows: boolean
	/** Warnings the host raised about the file, then the invisible-character note when it applies. */
	warnings: string[]
}

const capitalised = (text: string) => (text ? text[0]?.toUpperCase() + text.slice(1) : text)

/** The host says "replaces …" / "hidden by …"; the card says it as a sentence. */
export function shadowNote(raw: string): string {
	const text = raw.trim()
	if (/^hidden by /i.test(text)) return `${capitalised(text)}.`
	return `This ${text}.`
}

export function skillSaveView(card: SkillSaveCard, expanded: boolean): SkillSaveView {
	const lines = card.file.split('\n')
	const showAll = expanded || lines.length <= SKILL_PREVIEW_LINES
	const hiddenLines = showAll ? 0 : lines.length - SKILL_PREVIEW_LINES
	return {
		title: `Save the skill "${card.name}"?`,
		description: card.description,
		preview: showAll ? card.file : lines.slice(0, SKILL_PREVIEW_LINES).join('\n'),
		hiddenLines,
		canExpand: lines.length > SKILL_PREVIEW_LINES,
		targets: card.targets.map((target) => ({
			scope: target.scope,
			label: SKILL_SAVE_LABELS[target.scope],
			path: target.path,
			notes: target.shadows.map(shadowNote),
			suggested: card.suggested === target.scope,
		})),
		shadows: card.shadowsExisting,
		warnings: [
			...card.warnings,
			...(card.hiddenCharacters
				? ['The file has characters you cannot normally see. They are shown here as <U+XXXX>.']
				: []),
		],
	}
}

/** The card's answer, in the shape every question answers with. */
export function skillSaveResponse(choice: SkillSaveChoice): QuestionResponse {
	return {
		kind: 'answer',
		answers: [{ questionId: SKILL_SAVE_QUESTION_ID, selectedOptionIds: [choice] }],
	}
}

const SAVED_LABEL = /^Saved skill "([a-z0-9]+(?:-[a-z0-9]+)*)" to (.+)$/

/**
 * A finished `save_skill` call as the "saved" card reads it: the skill's name and where the file
 * went, taken from the line the tool itself wrote. Anything else is no saved skill.
 */
export function savedSkillOf(
	view: { kind: string; label?: string } | undefined,
): { name: string; path: string } | undefined {
	if (view?.kind !== 'generic' || typeof view.label !== 'string') return undefined
	const match = SAVED_LABEL.exec(view.label.split('\n', 1)[0] ?? '')
	return match?.[1] && match[2] ? { name: match[1], path: match[2] } : undefined
}

/** What the saved card says under its title. */
export const SKILL_SAVED_NOTE = 'Usable from your next message.'
