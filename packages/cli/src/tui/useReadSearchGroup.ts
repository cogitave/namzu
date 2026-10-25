import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef } from 'react'

import { joinSections } from './group-rows.js'
import {
	EMPTY_GROUP,
	type FoldOp,
	type GroupState,
	foldOp,
	groupText,
} from './read-search-group.js'
import { EXPAND_HINT } from './truncation.js'
import type { TranscriptMessage } from './types.js'

interface OpenGroup {
	readonly id: string
	state: GroupState
	/** The calls that joined it: their ends fold in here while it is open. */
	readonly members: Set<string>
	detail: readonly string[]
}

export interface ReadSearchGroupControls {
	/** A read, search, listing or connector call started: open the group or add to it. */
	readonly start: (memberKey: string, op: FoldOp) => void
	/** A member ended and succeeded: keep its text in the group. False when it is not a member of an open group. */
	readonly finish: (memberKey: string, section: readonly string[]) => boolean
	/** Settle the open group into its past-tense line. Does nothing when none is open. */
	readonly close: () => void
}

/** Without the hint bookkeeping, which belongs to a live run. */
function settled(state: GroupState): GroupState {
	const { hintShown: _a, hintShownAt: _b, hintQueued: _c, ...rest } = state
	return rest
}

/**
 * The one group of consecutive reads, searches and listings a live run keeps
 * open. The row is pending while it is open (present tense, counting up) and is
 * settled by the first thing that is not one of those calls: the model's text,
 * another kind of call, a notice, the person's message or the end of the turn.
 */
export function useReadSearchGroup(
	setMessages: Dispatch<SetStateAction<readonly TranscriptMessage[]>>,
	nextId: () => string,
): ReadSearchGroupControls {
	const openRef = useRef<OpenGroup | null>(null)

	const start = useCallback(
		(memberKey: string, op: FoldOp) => {
			const now = Date.now()
			const open = openRef.current
			if (open) {
				open.state = foldOp(open.state, op, now)
				open.members.add(memberKey)
				const { id, state } = open
				setMessages((prev) =>
					prev.map((m) =>
						m.id === id ? { ...m, group: state, content: groupText(state, true) } : m,
					),
				)
				return
			}
			const id = nextId()
			const state = foldOp(EMPTY_GROUP, op, now)
			openRef.current = { id, state, members: new Set([memberKey]), detail: [] }
			setMessages((prev) => [
				...prev,
				{
					id,
					role: 'tool',
					content: groupText(state, true),
					pending: true,
					glyph: ' ',
					activity: 'exploration',
					group: state,
				},
			])
		},
		[nextId, setMessages],
	)

	const finish = useCallback((memberKey: string, section: readonly string[]) => {
		const open = openRef.current
		if (!open?.members.has(memberKey)) return false
		open.detail = joinSections(open.detail, section)
		return true
	}, [])

	const close = useCallback(() => {
		const open = openRef.current
		if (!open) return
		openRef.current = null
		const { id, detail } = open
		const state = settled(open.state)
		setMessages((prev) =>
			prev.map((m) =>
				m.id === id
					? {
							...m,
							pending: false,
							group: state,
							content: groupText(state, false),
							...(detail.length > 0
								? {
										detail,
										meta: EXPAND_HINT,
										// Numbered as `pushMessage` numbers any body Ctrl+O can open.
										detailRef: prev.filter((row) => row.detailRef !== undefined).length + 1,
									}
								: {}),
						}
					: m,
			),
		)
	}, [setMessages])

	return useMemo(() => ({ start, finish, close }), [start, finish, close])
}
