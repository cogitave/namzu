/**
 * The one set of rules a skill's name, description and instructions must meet.
 *
 * `save_skill` (the model proposes, the person confirms) and `namzu skills
 * add|create` (the person supplies a file or flags) write the same `SKILL.md`
 * for the same loader, so they share these checks instead of each carrying a
 * copy that drifts. The messages are sentence fragments that begin with the
 * field (`name "x" must be …`): `save_skill` prefixes them with its own name and
 * the commands capitalise them.
 */

/** The kernel loader's own limits, checked here so the operator is never shown a file it would refuse. */
export const SKILL_NAME_MAX_CHARS = 64
export const SKILL_DESCRIPTION_MAX_CHARS = 1024
/** A skill body is instructions, not a document store. */
export const SKILL_BODY_MAX_BYTES = 64 * 1024

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SkillOrigin = 'created' | 'learned'

/** What the model proposed, after validation. */
export interface SkillDraft {
	readonly name: string
	readonly description: string
	readonly body: string
	readonly origin: SkillOrigin
}

export class SkillDraftError extends Error {
	override readonly name = 'SkillDraftError'
}

/** Text that looks like a markup tag (`<b>`, `</x>`, `<tag attr>`): a description is plain words. */
export function hasMarkupTags(text: string): boolean {
	return /<\/?[A-Za-z][^<>]*>/.test(text)
}

/**
 * A name a person could have meant, from free text: `Weekly Status` becomes
 * `weekly-status`. Empty when nothing usable is left.
 */
export function suggestSkillName(raw: string): string {
	return raw
		.replace(/ı/g, 'i')
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, SKILL_NAME_MAX_CHARS)
		.replace(/-+$/, '')
}

export function validateSkillName(raw: string): string {
	const name = raw.trim()
	if (name.length === 0 || name.length > SKILL_NAME_MAX_CHARS || !SKILL_NAME_PATTERN.test(name)) {
		throw new SkillDraftError(
			`name "${name}" must be 1–${SKILL_NAME_MAX_CHARS} lowercase letters, digits and single hyphens (like "release-notes").`,
		)
	}
	return name
}

/**
 * One line: the frontmatter holds a single-line value, and a description is
 * read by the model as one sentence or two anyway. `rejectMarkup` also refuses
 * `<tag>` text, which the commands do and `save_skill` has never done.
 */
export function validateSkillDescription(
	raw: string,
	options: { readonly rejectMarkup?: boolean } = {},
): string {
	const description = raw.replace(/\s+/g, ' ').trim()
	if (description.length === 0) throw new SkillDraftError('description must not be empty.')
	if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
		throw new SkillDraftError(
			`description is ${description.length} characters; at most ${SKILL_DESCRIPTION_MAX_CHARS}.`,
		)
	}
	if (options.rejectMarkup === true && hasMarkupTags(description)) {
		throw new SkillDraftError('description must not contain tags like <name>; write plain words.')
	}
	return description
}

export function validateSkillBody(raw: string): string {
	const body = raw.replace(/\r\n?/g, '\n').trim()
	if (body.length === 0) throw new SkillDraftError('body must not be empty.')
	const bytes = Buffer.byteLength(body, 'utf8')
	if (bytes > SKILL_BODY_MAX_BYTES) {
		throw new SkillDraftError(`body is ${bytes} bytes; at most ${SKILL_BODY_MAX_BYTES}.`)
	}
	if (/^---[ \t]*$/m.test(body.split('\n', 1)[0] ?? '')) {
		throw new SkillDraftError(
			'body must be the instructions only; pass name and description as fields, not as frontmatter.',
		)
	}
	return body
}

/**
 * Normalise and check a skill's three fields. Throws {@link SkillDraftError}
 * naming the first problem.
 */
export function validateSkillDraft(input: {
	readonly name: string
	readonly description: string
	readonly body: string
	readonly origin?: SkillOrigin
	/** Also refuse `<tag>` text in the description (the commands do; `save_skill` does not). */
	readonly rejectMarkup?: boolean
}): SkillDraft {
	const name = validateSkillName(input.name)
	const description = validateSkillDescription(input.description, {
		...(input.rejectMarkup === true ? { rejectMarkup: true } : {}),
	})
	const body = validateSkillBody(input.body)
	return { name, description, body, origin: input.origin ?? 'created' }
}
