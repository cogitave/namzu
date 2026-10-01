import { useCallback, useEffect, useRef, useState } from 'react'
import type { DraftSettings } from '../shared/protocol.js'

/** Main owns the draft; renderer reloads must not change the next message's choices. */
export function useDraftSettings(
	owner: string,
	enabled: boolean,
	onError: (error: unknown) => void,
) {
	const values = useRef<Record<string, DraftSettings>>({})
	const revisions = useRef<Record<string, number>>({})
	const writes = useRef<Record<string, Promise<void>>>({})
	const [snapshots, setSnapshots] = useState<Record<string, DraftSettings>>({})
	const failure = useRef(onError)
	failure.current = onError
	useEffect(() => {
		if (!enabled || values.current[owner] !== undefined) return
		let current = true
		const revision = revisions.current[owner] ?? 0
		void window.namzu.draftSettings(owner).then(
			(value) => {
				if (!current || revision !== (revisions.current[owner] ?? 0)) return
				values.current[owner] = value
				setSnapshots((all) => ({ ...all, [owner]: value }))
			},
			(error) => {
				if (!current) return
				// Keep the editor usable, and report that the saved choices could not be read.
				if (revision === (revisions.current[owner] ?? 0)) {
					values.current[owner] = {}
					setSnapshots((all) => ({ ...all, [owner]: {} }))
				}
				failure.current(error)
			},
		)
		return () => {
			current = false
		}
	}, [enabled, owner])
	const get = useCallback((target: string) => values.current[target] ?? {}, [])
	const save = useCallback((target: string, value: DraftSettings) => {
		const snapshot = structuredClone(value)
		revisions.current[target] = (revisions.current[target] ?? 0) + 1
		values.current[target] = snapshot
		setSnapshots((all) => ({ ...all, [target]: snapshot }))
		// Serialize each owner's writes so a slower earlier choice cannot replace a later one.
		const pending = (writes.current[target] ?? Promise.resolve())
			.catch(() => {})
			.then(() => window.namzu.saveDraftSettings(target, snapshot))
		writes.current[target] = pending
		return pending
	}, [])
	return {
		value: snapshots[owner] ?? {},
		loading: enabled && snapshots[owner] === undefined,
		get,
		save,
	}
}
