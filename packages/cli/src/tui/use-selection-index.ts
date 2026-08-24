import { useCallback, useRef, useState } from 'react'

export type SelectionIndexUpdate = number | ((current: number) => number)

/** React-rendered cursor plus a synchronous authority for terminal input bursts. */
export function useSelectionIndex(initial: number) {
	const [selection, setSelectionState] = useState(initial)
	const selectionRef = useRef(initial)
	const setSelection = useCallback((next: SelectionIndexUpdate) => {
		const resolved = typeof next === 'function' ? next(selectionRef.current) : next
		selectionRef.current = resolved
		setSelectionState(resolved)
	}, [])
	return { selection, selectionRef, setSelection }
}
