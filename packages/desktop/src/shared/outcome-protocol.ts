/**
 * What the Namzu host says a finished turn changed and what checked it, read before anything
 * trusts it. The desktop half of `packages/cli/src/commands/desktop-outcome-feed.ts`: the
 * notification is `namzu/session/outcome`, one per finished turn.
 *
 * The words come from the host (the terminal's own end-of-turn wording, written from the kernel's
 * record); this side admits them, bounded, and never writes any of its own.
 */
export const OUTCOME_NOTIFICATION = 'namzu/session/outcome'

export const OUTCOME_VERDICTS = [
	'unchanged',
	'checked',
	'stale',
	'failing',
	'inconclusive',
	'unchecked',
	'unknown',
] as const
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number]

/** What a turn keeps of its outcome: how it came out, the line for it, and how many files changed. */
export interface TurnOutcomeSummary {
	verdict: OutcomeVerdict
	/** One plain line; absent when the record has nothing to say. */
	line?: string
	changed: number
}

export interface OutcomeNotice extends TurnOutcomeSummary {
	sessionId: string
	turnId: string
}

const MAX_LINE = 500
const MAX_ID = 200
/** The largest count taken at face value; anything beyond is a damaged frame. */
const MAX_COUNT = 1e9

/** One line of printable text: control characters become spaces, so a command cannot move the cursor. */
function plainLine(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const plain = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return plain && plain.length <= MAX_LINE ? plain : undefined
}

/** The summary of a turn's outcome, or `undefined` when it does not read. Used for the wire and for saved history. */
export function readOutcomeSummary(value: unknown): TurnOutcomeSummary | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
	const raw = value as Record<string, unknown>
	const verdict = OUTCOME_VERDICTS.find((candidate) => candidate === raw.verdict)
	if (verdict === undefined) return undefined
	const changed =
		typeof raw.changed === 'number' &&
		Number.isSafeInteger(raw.changed) &&
		raw.changed >= 0 &&
		raw.changed <= MAX_COUNT
			? raw.changed
			: 0
	const line = verdict === 'unchanged' ? undefined : plainLine(raw.line)
	return { verdict, ...(line ? { line } : {}), changed }
}

export function readOutcomeNotice(value: unknown): OutcomeNotice | undefined {
	const summary = readOutcomeSummary(value)
	if (!summary) return undefined
	const raw = value as Record<string, unknown>
	if (
		typeof raw.sessionId !== 'string' ||
		raw.sessionId.length === 0 ||
		raw.sessionId.length > MAX_ID
	)
		return undefined
	if (typeof raw.turnId !== 'string' || raw.turnId.length === 0 || raw.turnId.length > MAX_ID)
		return undefined
	return { sessionId: raw.sessionId, turnId: raw.turnId, ...summary }
}
