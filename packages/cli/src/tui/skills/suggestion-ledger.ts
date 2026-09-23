/**
 * How many skill proposals in a row went unused, across conversations.
 *
 * `NAMZU_HOME/skills/.suggestions.json`. A proposal counts as unused until
 * the operator types `/skills save`; the fourth proposal after three unused
 * ones is replaced by a single line saying proposals have stopped, and none
 * follow until `/skills save on`. A missing or unreadable file reads as a
 * fresh start: the worst case is one more dim line.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Proposals left unused in a row before they stop. */
export const SUGGESTION_IGNORE_LIMIT = 3

export interface SuggestionLedger {
	readonly v: 1
	/** Proposals shown since the operator last used `/skills save`. */
	readonly unanswered: number
	/** Proposals stopped after {@link SUGGESTION_IGNORE_LIMIT} unused ones. */
	readonly stopped: boolean
}

export const FRESH_LEDGER: SuggestionLedger = { v: 1, unanswered: 0, stopped: false }

export function suggestionLedgerPath(namzuHome: string): string {
	return join(namzuHome, 'skills', '.suggestions.json')
}

export function readSuggestionLedger(namzuHome: string): SuggestionLedger {
	try {
		const raw = JSON.parse(readFileSync(suggestionLedgerPath(namzuHome), 'utf8')) as {
			unanswered?: unknown
			stopped?: unknown
		}
		const unanswered =
			typeof raw.unanswered === 'number' && Number.isInteger(raw.unanswered) && raw.unanswered >= 0
				? raw.unanswered
				: 0
		return { v: 1, unanswered, stopped: raw.stopped === true }
	} catch {
		return FRESH_LEDGER
	}
}

/** Best effort: a ledger that cannot be written leaves proposals as they were. */
export function writeSuggestionLedger(namzuHome: string, ledger: SuggestionLedger): void {
	const path = suggestionLedgerPath(namzuHome)
	try {
		mkdirSync(dirname(path), { recursive: true })
		const temp = `${path}.${process.pid}.tmp`
		writeFileSync(temp, `${JSON.stringify(ledger)}\n`, { mode: 0o600 })
		renameSync(temp, path)
	} catch {
		// Nothing depends on it but the anti-nag count.
	}
}

export type SuggestionAdmission =
	| { readonly show: 'proposal'; readonly next: SuggestionLedger }
	| { readonly show: 'stopped-notice'; readonly next: SuggestionLedger }
	| { readonly show: 'nothing' }

/** A turn earned a proposal: may it be shown, and what the ledger becomes. */
export function admitSuggestion(ledger: SuggestionLedger): SuggestionAdmission {
	if (ledger.stopped) return { show: 'nothing' }
	if (ledger.unanswered >= SUGGESTION_IGNORE_LIMIT) {
		return { show: 'stopped-notice', next: { ...ledger, stopped: true } }
	}
	return { show: 'proposal', next: { ...ledger, unanswered: ledger.unanswered + 1 } }
}
