import type { TurnOutcomeSummary } from '../shared/outcome-protocol.js'
import { formatLineCount } from './changes-totals.js'
import { clockLabel } from './time-format.js'
import { elapsedLabel, transcriptOutcome } from './transcript-layout.js'
import type { TurnChangeFile, TurnChanges } from './turn-changes.js'
import { type UndoCardView, partialLabel } from './undo-model.js'

export type ResultTone = 'ok' | 'warn' | 'error' | 'neutral'

/** What the line says about checking: the kernel's own sentence, nothing else. */
export interface ResultCheck {
	text: string
	tone: 'ok' | 'warn' | 'error' | 'plain'
}

export interface ResultLineModel {
	/** "Done", or how the turn ended when it did not end normally. */
	lead: string
	/** How long the turn took; absent under a second or when unknown. */
	duration?: string
	tone: ResultTone
	files: number
	/** Absent when only the file count is known (no receipt carried the edit). */
	added?: number
	removed?: number
	cut?: boolean
	check?: ResultCheck
	/** Said beside a failing check that a partial undo must not hide. */
	undo?: string
	/** Only for an `unknown` record: the counts are the edit tools' alone, and this is why. */
	caveat?: string
	/** The accessible name of the row, which reads the same facts as the sight does. */
	label: string
	/** The same facts as plain text, for Copy summary. */
	summary: string
}

/** Only the record's own openers read as a sentence start; a command name is never touched. */
const capital = (text: string) =>
	/^(checked:|ran )/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text

/**
 * The check part of the record's sentence. The host writes it as "<what changed> · <what checked
 * it>"; the first part is replaced by the counts, so only the second is kept. A turn that was not
 * checked and one the record could not read say nothing about checking.
 */
export function checkSegment(outcome: TurnOutcomeSummary | undefined): ResultCheck | undefined {
	if (!outcome?.line) return undefined
	const { verdict, line } = outcome
	if (verdict === 'unchecked' || verdict === 'unknown' || verdict === 'unchanged') return undefined
	const at = line.indexOf(' · ')
	const text = capital(at < 0 ? line : line.slice(at + 3))
	if (!text) return undefined
	return {
		text,
		tone: verdict === 'checked' ? 'ok' : verdict === 'failing' ? 'error' : 'warn',
	}
}

/** How the turn ended, in the word the line leads with. */
function leadFor(reason: string | undefined, failed: boolean): { lead: string; tone: ResultTone } {
	if (failed) return { lead: 'Failed', tone: 'error' }
	switch (transcriptOutcome(reason)) {
		case 'completed':
			return { lead: 'Done', tone: 'neutral' }
		case 'paused':
			return { lead: 'Paused', tone: 'warn' }
		case 'stopped':
			return { lead: 'Stopped', tone: 'warn' }
		case 'incomplete':
			return { lead: 'Incomplete', tone: 'warn' }
		default:
			return { lead: 'Finished', tone: 'neutral' }
	}
}

/** Said before the record's sentence when the counts are the edit tools' alone. */
const CAVEAT_LEAD = 'These are the edits made with the edit tools.'
/** The record's meaning for `unknown`, used only when its line is missing. */
const UNKNOWN_SENTENCE = 'A command ran that may have changed files'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * The foot of a finished turn: how it ended, how long it took, how big the change is, and what the
 * kernel's outcome record says about checking it. `undefined` when the turn changed nothing and the
 * record has no failing check to show, so the quiet foot stays quiet.
 */
export function turnResultModel(input: {
	reason?: string
	failed?: boolean
	durationMs?: number
	changes?: TurnChanges
	/** Only the record's file count, for a turn whose edits carried no receipts. */
	outcome?: TurnOutcomeSummary
	undo?: UndoCardView
}): ResultLineModel | undefined {
	const { changes, outcome, undo } = input
	// Only a verdict that says files changed lends its count; `unknown` and `unchanged` do not.
	const recorded =
		outcome && !['unknown', 'unchanged'].includes(outcome.verdict) ? outcome.changed : 0
	const files = changes?.files.length ?? recorded
	const failing = outcome?.verdict === 'failing'
	// A command that may have changed files, with edits counted from the edit tools: the counts
	// stand alone, and the record's own sentence stays reachable.
	const caveat =
		outcome?.verdict === 'unknown' && (changes?.files.length ?? 0) > 0
			? (outcome.line ?? UNKNOWN_SENTENCE)
			: undefined
	if (files === 0 && !failing) return undefined
	const ended = leadFor(input.reason, input.failed === true)
	// A failing record never reads as "Done": the turn finished, the kernel did not call it done.
	if (failing && ended.lead === 'Done') ended.lead = 'Finished'
	const duration =
		input.durationMs !== undefined && input.durationMs >= 1000
			? elapsedLabel(input.durationMs)
			: undefined
	let check = checkSegment(outcome)
	if (undo?.kind === 'undone')
		check = {
			text: undo.at ? `Undone at ${clockLabel(undo.at)}` : 'Undone',
			tone: 'plain',
		}
	let undone: string | undefined
	if (undo?.kind === 'partial') {
		if (check?.tone === 'error') undone = partialLabel(undo.kept)
		else check = { text: partialLabel(undo.kept), tone: 'plain' }
	}
	const tone: ResultTone =
		ended.tone === 'error' || check?.tone === 'error'
			? 'error'
			: ended.tone === 'warn' || check?.tone === 'warn'
				? 'warn'
				: check?.tone === 'ok'
					? 'ok'
					: 'neutral'
	const head = duration ? `${ended.lead} in ${duration}` : ended.lead
	const sized = files > 0
	const counted = sized && changes !== undefined
	const label = [
		head,
		sized ? `${plural(files, 'file')} changed` : undefined,
		counted ? `${formatLineCount(changes.added)} added` : undefined,
		counted ? `${formatLineCount(changes.removed)} removed` : undefined,
		check?.text,
		undone,
		caveat ? `${CAVEAT_LEAD} ${caveat}` : undefined,
	]
		.filter(Boolean)
		.join(', ')
	const summary = [
		head,
		sized
			? counted
				? `${plural(files, 'file')} +${formatLineCount(changes.added)} −${formatLineCount(changes.removed)}`
				: plural(files, 'file')
			: undefined,
		check?.text,
		undone,
		caveat ? `${CAVEAT_LEAD} ${caveat}` : undefined,
	]
		.filter(Boolean)
		.join(' · ')
	return {
		lead: ended.lead,
		...(duration ? { duration } : {}),
		tone,
		files,
		...(counted ? { added: changes.added, removed: changes.removed } : {}),
		...(changes?.cut ? { cut: true } : {}),
		...(check ? { check } : {}),
		...(undone ? { undo: undone } : {}),
		...(caveat ? { caveat: `${CAVEAT_LEAD} ${caveat}` } : {}),
		label,
		summary:
			changes && changes.files.length > 0
				? `${summary}\n${changes.files.map((file) => file.path).join('\n')}`
				: summary,
	}
}

/** The most files the "..." menu lists by name; the rest are one click away in the changes pane. */
export const MENU_FILES = 8

/**
 * The files the "..." menu offers to open, largest change first (the order the pane picks what to
 * open, equals in change order). A reply fully put back removed the files it made, so those are
 * left out; the files it only edited were restored and still exist.
 */
export function menuFiles(changes: TurnChanges | undefined, undo?: UndoCardView): TurnChangeFile[] {
	const present = (changes?.files ?? []).filter(
		(file) => !(undo?.kind === 'undone' && file.created),
	)
	return [...present].sort((a, b) => b.added + b.removed - (a.added + a.removed))
}
