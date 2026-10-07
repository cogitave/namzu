import { useEffect, useState } from 'react'
import type { DesktopApi, DesktopTurnUndo } from '../shared/protocol.js'

/**
 * How many files a partly undone reply still has to finish. The status carries no such count,
 * so it is read from a fresh plan, once per observed state of that reply.
 */
export function useUndoKept(
	undoPreview: DesktopApi['undoPreview'],
	sessionId: string,
	undo: Record<string, DesktopTurnUndo> | undefined,
): Record<string, number> {
	const [kept, setKept] = useState<{ sessionId: string; byKey: Record<string, number> }>({
		sessionId,
		byKey: {},
	})
	const partial = Object.values(undo ?? {}).filter((row) => row.status === 'partially_undone')
	const keys = partial.map((row) => `${row.turnId}:${row.undoneAt ?? 0}`).join('|')
	useEffect(() => {
		if (!undoPreview || !sessionId) return
		let current = true
		for (const key of keys.split('|').filter(Boolean)) {
			const turnId = key.slice(0, key.lastIndexOf(':'))
			undoPreview(sessionId, turnId)
				.then((preview) => {
					const count = preview.files.filter((file) => file.action !== 'noop').length
					if (current)
						setKept((all) =>
							all.sessionId === sessionId && all.byKey[key] === count
								? all
								: {
										sessionId,
										byKey: { ...(all.sessionId === sessionId ? all.byKey : {}), [key]: count },
									},
						)
				})
				.catch(() => {
					/* The card then reads "Partly undone" without a count. */
				})
		}
		return () => {
			current = false
		}
	}, [undoPreview, sessionId, keys])
	const out: Record<string, number> = {}
	if (kept.sessionId === sessionId)
		for (const row of partial) {
			const count = kept.byKey[`${row.turnId}:${row.undoneAt ?? 0}`]
			if (count !== undefined) out[row.turnId] = count
		}
	return out
}
