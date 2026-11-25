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

export const SKILL_SAVE_LABELS: Readonly<Record<SkillSaveChoice, string>> = {
	user: 'Save skill',
	project: 'Save to project',
	cancel: 'Cancel',
}

/** Where each choice writes, in the words the terminal and the skills list use for it. */
export const SKILL_SAVE_PLACES: Readonly<Record<'user' | 'project', string>> = {
	user: 'User',
	project: 'Project',
}

export interface SkillSaveTargetView {
	scope: 'user' | 'project'
	/** The button that saves here. */
	label: string
	/** The heading over the path: where this is, not what the button does. */
	place: string
	/** Where the file would be written, as the person would type it. */
	path: string
	/** What saving here would replace or lose to, in one sentence each. */
	notes: string[]
	suggested: boolean
}

export interface SkillSaveView {
	title: string
	description: string
	/** The whole file, never a cut of it: saving is only offered over text the person can read. */
	preview: string
	/** How many lines the file has, so the card can say how long it is. */
	lineCount: number
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

export function skillSaveView(card: SkillSaveCard): SkillSaveView {
	return {
		title: `Save skill "${card.name}"?`,
		description: card.description,
		preview: card.file,
		lineCount: card.file.split('\n').length,
		targets: card.targets.map((target) => ({
			scope: target.scope,
			label: SKILL_SAVE_LABELS[target.scope],
			place: SKILL_SAVE_PLACES[target.scope],
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
/** The tool's result as the host sends it once the call is done: the same sentence, then a note. */
const SAVED_RESULT = /^Saved skill "([a-z0-9]+(?:-[a-z0-9]+)*)" to (.+?SKILL\.md)(?:\.|$)/

/**
 * A finished `save_skill` call as the "saved" card reads it: the skill's name and where the file
 * went, taken from the line the tool itself wrote. A finished call arrives as a terminal view with
 * the tool's output (the live host), or as a one-line label; anything else is no saved skill.
 */
export function savedSkillOf(
	view: { kind: string; label?: string; output?: string } | undefined,
): { name: string; path: string } | undefined {
	let match: RegExpExecArray | null = null
	if (view?.kind === 'generic' && typeof view.label === 'string')
		match = SAVED_LABEL.exec(view.label.split('\n', 1)[0] ?? '')
	else if (view?.kind === 'terminal' && typeof view.output === 'string')
		match = SAVED_RESULT.exec(view.output.split('\n', 1)[0] ?? '')
	return match?.[1] && match[2] ? { name: match[1], path: match[2] } : undefined
}

/** The tool whose finished call may draw the saved card; no other tool's output ever does. */
export const SAVE_SKILL_TOOL = 'save_skill'

/** A transcript tool as the saved card reads it: only a completed `save_skill` call counts. */
export function savedSkillOfTool(
	tool:
		| { title?: string; status: string; view?: { kind: string; label?: string; output?: string } }
		| undefined,
): { name: string; path: string } | undefined {
	if (!tool || tool.title !== SAVE_SKILL_TOOL || tool.status !== 'completed') return undefined
	return savedSkillOf(tool.view)
}

/** What the saved card says under its title. */
export const SKILL_SAVED_NOTE = 'Usable from your next message.'
