import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef } from 'react'

import { groupFields, joinSections } from './group-rows.js'
import {
	EMPTY_GROUP,
	type FoldOp,
	type GroupState,
	foldOp,
	isOneCommand,
} from './read-search-group.js'
import { shellCollapses } from './shell-cell.js'
import { EXPAND_HINT } from './truncation.js'
import type { TranscriptMessage } from './types.js'

interface OpenGroup {
	readonly id: string
	state: GroupState
	/** Every call that joined it, in order: what the state is made of. */
	ops: { readonly key: string; readonly op: FoldOp }[]
	/** The calls that joined it: their ends fold in here while it is open. */
	readonly members: Set<string>
	detail: readonly string[]
}

export interface ReadSearchGroupControls {
	/**
	 * A read, search, listing or connector call started, or a shell command ended
	 * well: open the group or add to it. A command brings its text for the
	 * detailed transcript, since it joins only once it is done.
	 */
	readonly start: (memberKey: string, op: FoldOp, section?: readonly string[]) => void
	/** A member ended, whether it worked or failed: keep its text in the group. False when it is not a member of an open group. */
	readonly finish: (memberKey: string, section: readonly string[]) => boolean
	/** A member turned out not to be work (a call to a tool that does not exist): take it back out. */
	readonly retract: (memberKey: string) => void
	/** Settle the open group into its past-tense line. Does nothing when none is open. */
	readonly close: () => void
}

/** Without the hint bookkeeping, which belongs to a live run. */
function settled(state: GroupState): GroupState {
	const { hintShown: _a, hintShownAt: _b, hintQueued: _c, ...rest } = state
	return rest
}

/** The state of these calls with no hint of their own; the hint a live run holds is carried over. */
function rebuilt(ops: OpenGroup['ops'], from: GroupState): GroupState {
	let state = EMPTY_GROUP
	for (const { op } of ops) state = foldOp(state, { ...op, hint: undefined }, 0)
	return {
		...state,
		...(from.hintShown !== undefined ? { hintShown: from.hintShown } : {}),
		...(from.hintShownAt !== undefined ? { hintShownAt: from.hintShownAt } : {}),
		...(from.hintQueued !== undefined ? { hintQueued: from.hintQueued } : {}),
	}
}

/** Numbered as `pushMessage` numbers any body Ctrl+O can open. */
function numberOf(prev: readonly TranscriptMessage[], id: string): number {
	return prev.filter((row) => row.id !== id && row.detailRef !== undefined).length + 1
}

/** The row for a group's state, with the fields that follow from it. */
function shaped(
	m: TranscriptMessage,
	state: GroupState,
	live: boolean,
	prev: readonly TranscriptMessage[],
): TranscriptMessage {
	const { detailRef: _ref, meta: _meta, ...rest } = m
	const alone = isOneCommand(state) && shellCollapses(state.cell.shell)
	return {
		...rest,
		...groupFields(state, live),
		...(alone ? { detailRef: numberOf(prev, m.id) } : {}),
	}
}

/**
 * The one group of consecutive reads, searches, listings and finished shell
 * commands a live run keeps open. The row is pending while it is open (present
 * tense, counting up) and is settled by the first thing that is not one of
 * those: the model's text, another kind of call, a command that failed, a
 * notice, the person's message or the end of the turn.
 */
export function useReadSearchGroup(
	setMessages: Dispatch<SetStateAction<readonly TranscriptMessage[]>>,
	nextId: () => string,
	/** Hands over the reasoning that came before this row, once, or nothing. */
	takeThinking?: () => string | undefined,
): ReadSearchGroupControls {
	const openRef = useRef<OpenGroup | null>(null)

	const start = useCallback(
		(memberKey: string, op: FoldOp, section?: readonly string[]) => {
			const now = Date.now()
			const open = openRef.current
			if (open) {
				open.state = foldOp(open.state, op, now)
				open.ops.push({ key: memberKey, op })
				open.members.add(memberKey)
				if (section) open.detail = joinSections(open.detail, section)
				const { id, state, detail } = open
				const more = takeThinking?.()
				setMessages((prev) =>
					prev.map((m) =>
						m.id === id
							? {
									...shaped(m, state, true, prev),
									...(section ? { detail } : {}),
									...(more ? { thinking: `${m.thinking ?? ''}${more}` } : {}),
								}
							: m,
					),
				)
				return
			}
			const id = nextId()
			const state = foldOp(EMPTY_GROUP, op, now)
			const detail = section ? joinSections([], section) : []
			openRef.current = {
				id,
				state,
				ops: [{ key: memberKey, op }],
				members: new Set([memberKey]),
				detail,
			}
			const thinking = takeThinking?.()
			setMessages((prev) => [
				...prev,
				shaped(
					{
						id,
						role: 'tool',
						content: '',
						pending: true,
						...(detail.length > 0 ? { detail } : {}),
						...(thinking ? { thinking } : {}),
					},
					state,
					true,
					prev,
				),
			])
		},
		[nextId, setMessages, takeThinking],
	)

	const finish = useCallback(
		(memberKey: string, section: readonly string[]) => {
			const open = openRef.current
			if (!open?.members.has(memberKey)) return false
			open.detail = joinSections(open.detail, section)
			// The detailed transcript shows an open group whole, so what each call
			// has returned so far is kept on the row, not only once it settles.
			const { id, detail } = open
			setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, detail } : m)))
			return true
		},
		[setMessages],
	)

	const retract = useCallback(
		(memberKey: string) => {
			const open = openRef.current
			if (!open?.members.has(memberKey)) return
			open.members.delete(memberKey)
			open.ops = open.ops.filter((entry) => entry.key !== memberKey)
			const { id } = open
			if (open.ops.length === 0) {
				// It held nothing else: there is no line to draw.
				openRef.current = null
				setMessages((prev) => prev.filter((m) => m.id !== id))
				return
			}
			open.state = rebuilt(open.ops, open.state)
			const { state } = open
			setMessages((prev) => prev.map((m) => (m.id === id ? shaped(m, state, true, prev) : m)))
		},
		[setMessages],
	)

	const close = useCallback(() => {
		const open = openRef.current
		if (!open) return
		openRef.current = null
		const { id, detail } = open
		const state = settled(open.state)
		setMessages((prev) =>
			prev.map((m) => {
				if (m.id !== id) return m
				const row = { ...shaped(m, state, false, prev), pending: false }
				// One command is its own row, with no hint of the line's.
				if (isOneCommand(state)) return row
				return {
					...row,
					...(detail.length > 0
						? { detail, meta: EXPAND_HINT, detailRef: numberOf(prev, id) }
						: {}),
				}
			}),
		)
	}, [setMessages])

	return useMemo(() => ({ start, finish, retract, close }), [start, finish, retract, close])
}
