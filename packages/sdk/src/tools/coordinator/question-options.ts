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
 *   word; the English marker speaks only where the field is absent.
 * - On a recommended option, a trailing parenthesised group of one to three
 *   words, in ASCII or full-width parentheses, is the marker a model writes
 *   out of habit next to the flag, when no other option's label ends in such a
 *   group and removing it leaves a label no other option has. The model is
 *   told never to end a label in a parenthesised note, so on a compliant call
 *   that group is a marker; the two conditions keep a qualifier the options
 *   share ("Postgres (managed)" / "Postgres (self-hosted)") and one that is
 *   all that tells two options apart.
 * - Nothing else is a recommendation. Recommending is optional, so an option
 *   the model did not flag, first or not, keeps its trailing group
 *   ("Cloud (AWS)", "Tabs (current)") and is never marked recommended because
 *   of one; `recommended: false` is never overridden.
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
	const candidates = working.filter((option) => option.recommended)
	const qualifiedElsewhere = working.some(
		(option) => !candidates.includes(option) && trailingGroup(option.label) !== null,
	)
	if (!qualifiedElsewhere) {
		for (const candidate of candidates) {
			const group = trailingGroup(candidate.label)
			if (!group || group.base === '' || !MARKER_TEXT.test(group.text)) continue
			const base = group.base.toLocaleLowerCase()
			const clashes = working.some(
				(option) => option !== candidate && option.label.toLocaleLowerCase() === base,
			)
			if (clashes) continue
			candidate.label = group.base
		}
	}

	return working.map((option, index) => ({
		id: `opt_${index + 1}`,
		label: option.label,
		...(option.description !== undefined ? { description: option.description } : {}),
		...(option.recommended ? { recommended: true } : {}),
	}))
}
