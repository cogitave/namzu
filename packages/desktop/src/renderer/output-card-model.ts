import { formatSize } from '../shared/format-size.js'
import {
	type OutputCardKind,
	isTextOutput,
	mayOpenWithSystem,
	outputCardKind,
	outputFormatLabel,
	outputKindWord,
} from '../shared/output-files.js'
import type { ThreadState } from '../shared/projection.js'
import type { SessionOutputDetail } from '../shared/protocol.js'
import type { OutputFile } from './outputs-model.js'
import { skillNameOf } from './tool-transcript-presentation.js'
import { type TurnChanges, baseName } from './turn-changes.js'

/**
 * The cards under a reply: one for each document the reply made. Ordinary files (code, data,
 * pages, pictures, plain Markdown written with the file tools) get no card: they show as steps in
 * the activity line, as the reply's own links and in the Outputs list of the details column. A
 * document is a file the built-in document skill wrote; Word, PDF, slides and spreadsheets made by
 * a document service join it later through `isDocumentFile`. The list comes from the same receipts
 * and made-file records the Outputs pane reads, so a card and the pane never disagree.
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
	/** The one word at the row's right: Created, Edited, Opened, Writing, Failed. */
	stateWord: string
	/** Opens beside the conversation: only a finished card does. */
	canOpen: boolean
	canOpenInBrowser: boolean
	canOpenWithSystem: boolean
	canCopy: boolean
	canSave: boolean
	/** The file's folder opens in the system's file manager: a file handed over always can. */
	canShowInFolder: boolean
	/** The agent handed this file over with `present_file`. */
	shared?: true
	/** The one line the agent gave with a shared file. */
	caption?: string
}

/** Cards beyond this many are folded behind "Show N more". */
export const CARDS_SHOWN = 3

/** The skill whose Markdown file is a document card. */
export const DOCUMENT_SKILL = 'document'

/**
 * Whether a file belongs on a card: a document the document skill wrote in this reply. Only
 * Markdown and text files are in scope today; the formats a document service makes later are
 * added here.
 */
export function isDocumentFile(path: string, documentTurn: boolean): boolean {
	return documentTurn && outputCardKind(path) === 'document'
}

function documentTurnOf(thread: Pick<ThreadState, 'timeline' | 'tools'>, turn: number): boolean {
	for (const entry of thread.timeline) {
		if (entry.kind !== 'tool' || entry.turn !== turn) continue
		const tool = thread.tools[entry.id]
		if (tool && skillNameOf(tool) === DOCUMENT_SKILL && tool.status !== 'failed') return true
	}
	return false
}

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

function doneCard(
	turn: number,
	path: string,
	detail: SessionOutputDetail | undefined,
	created: boolean,
): OutputCard {
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
		stateWord: gone ? 'Missing' : created ? 'Created' : 'Edited',
		canOpen: !gone,
		canOpenInBrowser: !gone && /\.html?$/.test(ext),
		canOpenWithSystem: !gone && mayOpenWithSystem(path),
		canCopy: !gone && isTextOutput(path),
		canSave: !gone,
		canShowInFolder: false,
	}
}

/** A card for a file the agent handed over with `present_file`. */
function sharedCard(
	turn: number,
	file: { path: string; bytes?: number },
	caption: string | undefined,
	detail: SessionOutputDetail | undefined,
): OutputCard {
	const gone = detail?.missing === true
	const size = detail?.size ?? file.bytes
	return {
		key: `${turn}:shared:${file.path}`,
		path: file.path,
		name: baseName(file.path),
		kind: outputCardKind(file.path),
		state: gone ? 'gone' : 'done',
		kindLine: gone ? 'No longer in the folder' : cardKindLine(file.path, size),
		stateWord: gone ? 'Missing' : 'Shared',
		canOpen: !gone,
		canOpenInBrowser: !gone && /\.html?$/i.test(file.path),
		canOpenWithSystem: !gone && mayOpenWithSystem(file.path),
		canCopy: !gone && isTextOutput(file.path),
		canSave: !gone,
		canShowInFolder: !gone,
		shared: true,
		...(caption ? { caption } : {}),
	}
}

/** The files the agent handed over in one reply, in the order it handed them. */
export function sharedFilesOf(
	thread: Pick<ThreadState, 'timeline' | 'tools'>,
	turn: number,
): { path: string; bytes?: number; caption?: string }[] {
	const out: { path: string; bytes?: number; caption?: string }[] = []
	for (const entry of thread.timeline) {
		if (entry.kind !== 'tool' || entry.turn !== turn) continue
		const tool = thread.tools[entry.id]
		if (!tool || tool.status !== 'completed' || tool.facts?.kind !== 'shared') continue
		let first = true
		for (const file of tool.facts.files) {
			if (out.some((seen) => seen.path === file.path)) continue
			// The caption speaks for the whole call, so only its first card carries it.
			out.push({ ...file, ...(first && tool.facts.caption ? { caption: tool.facts.caption } : {}) })
			first = false
		}
	}
	return out
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
		stateWord: state === 'writing' ? 'Writing' : state === 'declined' ? 'Declined' : 'Failed',
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
		canShowInFolder: false,
	}
}

/**
 * The cards for one reply, in the order the files were made: the documents the document skill
 * wrote or changed, and a document write that is running, failed or was declined. Everything else
 * the reply wrote stays out; a reply that was put back makes none.
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
	const documentTurn = documentTurnOf(thread, turn)
	const cards: OutputCard[] = []
	const seen = new Set<string>()
	// What the agent handed over comes first and stands on its own: it needs no document skill.
	for (const file of sharedFilesOf(thread, turn)) {
		seen.add(file.path)
		cards.push(sharedCard(turn, file, file.caption, details.get(file.path)))
	}
	if (!documentTurn) return cards
	for (const file of changes?.files ?? []) {
		if (!file.path || file.path === 'File' || seen.has(file.path)) continue
		if (!isDocumentFile(file.path, documentTurn)) continue
		seen.add(file.path)
		cards.push(doneCard(turn, file.path, details.get(file.path), file.created))
	}
	for (const file of made) {
		if (!file.made || file.turn !== turn || seen.has(file.path)) continue
		if (!isDocumentFile(file.path, documentTurn)) continue
		seen.add(file.path)
		cards.push(doneCard(turn, file.path, details.get(file.path), true))
	}
	for (const entry of thread.timeline) {
		if (entry.kind !== 'tool' || entry.turn !== turn) continue
		const tool = thread.tools[entry.id]
		if (!tool || tool.status === 'completed') continue
		const path = writtenPath(tool)
		if (!path || seen.has(path) || !isDocumentFile(path, documentTurn)) continue
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
	/** The caption over the rows: only a longer block names itself. */
	caption: boolean
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
	return {
		label: cards.length === 1 ? '1 output' : `${cards.length} outputs`,
		caption: cards.length > CARDS_SHOWN,
		rows: shown,
		hidden: cards.length - shown.length,
	}
}

/** The accessible name of a card: what it is, how big, and what pressing it does. */
export function cardAccessibleName(card: OutputCard): string {
	return card.canOpen
		? `${card.name}, ${card.kindLine}. Open beside the conversation.`
		: `${card.name}, ${card.kindLine}${card.reason ? `. ${card.reason}` : ''}`
}
