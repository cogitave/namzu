/**
 * The options of an `ask_user_question` call as a host shows them and as the
 * answer names them: which one the model recommends, and each one's label
 * without a recommendation marker in it.
 *
 * The model used to be told to append " (Recommended)" to the label, and the
 * tool removed only that English form. A model answering in the user's
 * language wrote "(Önerilen)" or "(Empfohlen)" instead, which reached the
 * screen, the recorded answer and the model's own next read of it; and a host
 * could learn which option was recommended only by parsing labels. The
 * recommendation is now a field (`recommended: true`), and the marker a model
 * still writes out of habit is removed here, in any language:
 *
 * - "(Recommended)" at the end of a label, in any letter case, is a marker on
 *   whichever option carries it: it comes off, and the option is recommended
 *   unless the model set `recommended: false` on it. The field is the model's
 *   word; the English marker speaks only where the field is absent. So an
 *   option is recommended when the model set `recommended: true` on it, or
 *   left the flag out and ended its label in "(Recommended)".
 * - On a recommended option, a trailing parenthesised group of one to three
 *   words, in ASCII or full-width parentheses, is the marker a model writes
 *   out of habit next to the flag, when every option whose label ends in a
 *   group is recommended and ends in that same group. The model is told never
 *   to end a label in a parenthesised note, so on a compliant call that group
 *   is a marker, and a model writing one writes the same word on each option
 *   it recommends. A group that differs between options, flagged or not, is
 *   what tells them apart ("Tests (unit)" / "Tests (e2e)", "Postgres
 *   (managed)" / "Postgres (self-hosted)"), and stays.
 * - A marker stays, too, on an option whose label without it would be the
 *   label of another option, as written or without its own marker: then the
 *   marker is all that tells the two apart.
 * - Which labels change is decided on the labels as written, before any
 *   changes, so the outcome does not depend on the order of the options.
 * - Nothing else changes a label or makes an option recommended.
 *   Recommending is optional, so an option that is not recommended, first or
 *   not, keeps its label as written apart from surrounding spaces and a
 *   trailing "(Recommended)": its trailing group ("Cloud (AWS)",
 *   "Tabs (current)", "Kurul (Önerilen)") is never read as a recommendation,
 *   and `recommended: false` is never overridden.
 */

import type { UserQuestionOption } from '../../types/hitl/index.js'

/** One option as the model wrote it. */
export interface AuthoredQuestionOption {
	readonly label: string
	readonly description?: string
	readonly recommended?: boolean
}

/** A label's last parenthesised group, ASCII "(…)" or full-width "（…）". */
const TRAILING_GROUP = /^(.*?)\s*(?:\(([^()]*)\)|（([^（）]*)）)\s*$/su

/** One to three words of letters: the shape of "Recommended" in any language. */
const MARKER_TEXT = /^[\p{L}\p{M}]+(?:[\s'’-]+[\p{L}\p{M}]+){0,2}$/u

const ENGLISH_MARKER = /^recommended$/i

interface TrailingGroup {
	/** The label before the group, trimmed. */
	readonly base: string
	/** The text inside the parentheses, trimmed. */
	readonly text: string
}

function trailingGroup(label: string): TrailingGroup | null {
	const match = TRAILING_GROUP.exec(label)
	if (!match) return null
	return { base: (match[1] ?? '').trim(), text: (match[2] ?? match[3] ?? '').trim() }
}

/** A label or a group's text as two options are compared by. */
function fold(text: string): string {
	return text.normalize('NFC').replace(/\s+/gu, ' ').toLocaleLowerCase()
}

/**
 * The options' trailing groups are one localised marker: every option that
 * ends in a group is recommended, and all of them end in the same one-to-three
 * word group.
 */
function isMarker(grouped: readonly { option: Working; group: TrailingGroup }[]): boolean {
	const first = grouped[0]
	if (!first || !MARKER_TEXT.test(first.group.text)) return false
	const text = fold(first.group.text)
	return grouped.every(({ option, group }) => option.recommended && fold(group.text) === text)
}

interface Working {
	label: string
	readonly recommended: boolean
	readonly description: string | undefined
}

/**
 * The options a question parks with: positional ids (`opt_1`…), labels without
 * a recommendation marker, and `recommended: true` on each recommended option.
 */
export function questionOptions(options: readonly AuthoredQuestionOption[]): UserQuestionOption[] {
	const working: Working[] = options.map((option) => {
		// Trimmed, as the answer always quoted it; a label of spaces is kept.
		const label = option.label.trim() || option.label
		const group = trailingGroup(label)
		// Unambiguous wherever it appears; kept for a model trained on it.
		const english = group !== null && ENGLISH_MARKER.test(group.text)
		return {
			label: english && group.base !== '' ? group.base : label,
			// An explicit `false` stands even against the English marker.
			recommended: option.recommended ?? english,
			description: option.description,
		}
	})

	// Only a recommended option can carry a localised marker. An unflagged
	// one is left as written: its group is as likely "(AWS)" as "(Önerilen)",
	// and guessing turned a qualifier into a recommendation.
	const grouped = working.flatMap((option) => {
		const group = trailingGroup(option.label)
		return group ? [{ option, group }] : []
	})
	if (isMarker(grouped)) {
		// Each option is judged against the others' labels as written and as
		// they would read without the marker, and nothing is shortened until
		// every option is judged: the order of the options changes nothing.
		const bases = new Map(grouped.map(({ option, group }) => [option, fold(group.base)]))
		const shortened = grouped.filter(({ option, group }) => {
			if (group.base === '') return false
			const base = fold(group.base)
			return !working.some(
				(other) => other !== option && (fold(other.label) === base || bases.get(other) === base),
			)
		})
		for (const { option, group } of shortened) option.label = group.base
	}

	return working.map((option, index) => ({
		id: `opt_${index + 1}`,
		label: option.label,
		...(option.description !== undefined ? { description: option.description } : {}),
		...(option.recommended ? { recommended: true } : {}),
	}))
}
