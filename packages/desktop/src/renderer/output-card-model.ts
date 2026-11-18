import { formatSize } from '../shared/format-size.js'
import {
	type OutputCardKind,
	isMadeFileKind,
	isTextOutput,
	mayOpenWithSystem,
	outputCardKind,
	outputFormatLabel,
	outputKindWord,
} from '../shared/output-files.js'
import type { ThreadState } from '../shared/projection.js'
import type { SessionOutputDetail } from '../shared/protocol.js'
import type { OutputFile } from './outputs-model.js'
import { type TurnChanges, baseName } from './turn-changes.js'

/**
 * The cards under a reply: one for each result the reply made. The list comes from the same
 * receipts and made-file records the Outputs pane reads, so a card and the pane never disagree.
 * A card is only ever built from a path, a state and the host's facts about the file.
 */

export type OutputCardState = 'writing' | 'done' | 'failed' | 'declined' | 'gone'

export interface OutputCard {
	/** Stable for the reply: the turn and the path. */
	key: string
	path: string
	name: string
	kind: OutputCardKind
	state: OutputCardState
	/** "Document · Markdown · 6 KB", "Writing…", or the plain reason a file could not be made. */
	kindLine: string
	/** Why a failed card failed, in one plain sentence. */
	reason?: string
	/** One line of the start of a document or of code. */
	preview?: string
	/** Opens beside the conversation: only a finished card does. */
	canOpen: boolean
	canOpenInBrowser: boolean
	canOpenWithSystem: boolean
	canCopy: boolean
	canSave: boolean
}

/** Cards beyond this many are folded behind "Show N more". */
export const CARDS_SHOWN = 4

const WRITE_FAILURES: Record<string, string> = {
	permission_denied: 'Namzu didn’t have permission.',
	blocked: 'It wasn’t allowed.',
	already_exists: 'A file with that name already exists.',
	not_found: 'The folder wasn’t found.',
	needs_administrator: 'It needs administrator rights.',
	timed_out: 'It took too long.',
	not_a_file: 'A file is in the way of the folder.',
	invalid_input: 'Namzu couldn’t read its own request.',
	invalid_arguments: 'Namzu couldn’t read its own request.',
}

function writtenPath(tool: ThreadState['tools'][string]): string | undefined {
	const call = tool.callView?.kind === 'generic' ? tool.callView.facts : undefined
	for (const facts of [tool.facts, call]) {
		if (facts?.kind === 'write') return facts.path
		if (facts?.kind === 'failure' && call?.kind === 'write') return call.path
	}
	// A real write call is drawn as a diff before it runs and carries no facts until it ends, and a
	// failed one reports the file as the failure's subject: both name the file the call meant to make.
	if (tool.title.toLowerCase() !== 'write') return undefined
	if (tool.facts?.kind === 'failure' && tool.facts.subject) return tool.facts.subject
	for (const view of [tool.callView, tool.view])
		if (view?.kind === 'diff' && view.path) return view.path
	return undefined
}

export function cardKindLine(path: string, size?: number): string {
	const kind = outputCardKind(path)
	const format = outputFormatLabel(path)
	return [outputKindWord(kind), format, size === undefined ? '' : formatSize(size)]
		.filter(Boolean)
		.join(' · ')
}

function doneCard(turn: number, path: string, detail: SessionOutputDetail | undefined): OutputCard {
	const kind = outputCardKind(path)
	const ext = path.toLowerCase()
	const gone = detail?.missing === true
	return {
		key: `${turn}:${path}`,
		path,
		name: baseName(path),
		kind,
		state: gone ? 'gone' : 'done',
		kindLine: gone ? 'No longer in the folder' : cardKindLine(path, detail?.size),
		...(detail?.preview && !gone ? { preview: detail.preview } : {}),
		canOpen: !gone,
		canOpenInBrowser: !gone && /\.html?$/.test(ext),
		canOpenWithSystem: !gone && mayOpenWithSystem(path),
		canCopy: !gone && isTextOutput(path),
		canSave: !gone,
	}
}

function pendingCard(
	turn: number,
	path: string,
	state: 'writing' | 'failed' | 'declined',
	reason?: string,
): OutputCard {
	return {
		key: `${turn}:${path}:${state}`,
		path,
		name: baseName(path),
		kind: outputCardKind(path),
		state,
		kindLine:
			state === 'writing'
				? 'Writing…'
				: state === 'declined'
					? 'You declined this'
					: 'Couldn’t write this file',
		...(reason ? { reason } : {}),
		canOpen: false,
		canOpenInBrowser: false,
		canOpenWithSystem: false,
		canCopy: false,
		canSave: false,
	}
}

/**
 * The cards for one reply, in the order the files were made. A file the reply wrote is a card when
 * the reply created it, or when it is a page, document, picture, sheet or set of slides it
 * changed; edits to source code stay in the Changes panel. A reply that was put back makes none.
 */
export function turnOutputCards(
	thread: Pick<ThreadState, 'timeline' | 'tools' | 'turns' | 'undo' | 'running' | 'turn'> &
		Partial<Pick<ThreadState, 'activeToolIds'>>,
	turn: number,
	changes: TurnChanges | undefined,
	made: readonly OutputFile[],
	details: ReadonlyMap<string, SessionOutputDetail>,
): OutputCard[] {
	const turnId = thread.turns[turn]?.turnId
	if (turnId && thread.undo?.[turnId]?.status === 'undone') return []
	const cards: OutputCard[] = []
	const seen = new Set<string>()
	for (const file of changes?.files ?? []) {
		if (!file.path || file.path === 'File' || seen.has(file.path)) continue
		if (!file.created && !isMadeFileKind(file.path)) continue
		seen.add(file.path)
		cards.push(doneCard(turn, file.path, details.get(file.path)))
	}
	for (const file of made) {
		if (!file.made || file.turn !== turn || seen.has(file.path)) continue
		seen.add(file.path)
		cards.push(doneCard(turn, file.path, details.get(file.path)))
	}
	for (const entry of thread.timeline) {
		if (entry.kind !== 'tool' || entry.turn !== turn) continue
		const tool = thread.tools[entry.id]
		if (!tool || tool.status === 'completed') continue
		const path = writtenPath(tool)
		if (!path || seen.has(path)) continue
		if (tool.status === 'pending') {
			const active =
				thread.running && thread.turn === turn && (thread.activeToolIds?.includes(entry.id) ?? true)
			if (!active) continue
			seen.add(path)
			cards.push(pendingCard(turn, path, 'writing'))
		} else if (tool.view.kind === 'generic' && tool.view.declined) {
			seen.add(path)
			cards.push(pendingCard(turn, path, 'declined'))
		} else if (tool.status === 'failed') {
			const reason = tool.facts?.kind === 'failure' ? WRITE_FAILURES[tool.facts.reason] : undefined
			seen.add(path)
			cards.push(pendingCard(turn, path, 'failed', reason ?? 'The file couldn’t be written.'))
		}
	}
	return cards
}

export interface OutputGroupView {
	/** "1 output", "3 outputs". */
	label: string
	/** A reply with one result draws it large. */
	large: boolean
	/** Finished pictures, drawn two to a row; empty when there is only one card. */
	pictures: OutputCard[]
	/** Everything else, in order. */
	rows: OutputCard[]
	hidden: number
}

/** The cards that show now, and how many wait behind "Show N more". */
export function outputGroupView(cards: readonly OutputCard[], expanded: boolean): OutputGroupView {
	// A card that failed is never folded away: failures come first, the rest keep their order.
	const ordered = [
		...cards.filter((card) => card.state === 'failed'),
		...cards.filter((card) => card.state !== 'failed'),
	]
	const shown = expanded ? ordered : ordered.slice(0, CARDS_SHOWN)
	const large = cards.length === 1
	const isPicture = (card: OutputCard) => card.kind === 'image' && card.state === 'done'
	const pictures = !large && shown.filter(isPicture).length >= 2 ? shown.filter(isPicture) : []
	return {
		label: cards.length === 1 ? '1 output' : `${cards.length} outputs`,
		large,
		pictures,
		rows: shown.filter((card) => !pictures.includes(card)),
		hidden: cards.length - shown.length,
	}
}

/** The accessible name of a card: what it is, how big, and what pressing it does. */
export function cardAccessibleName(card: OutputCard): string {
	return card.canOpen
		? `${card.name}, ${card.kindLine}. Open beside the conversation.`
		: `${card.name}, ${card.kindLine}${card.reason ? `. ${card.reason}` : ''}`
}
