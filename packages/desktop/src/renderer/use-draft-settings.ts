import { useCallback, useEffect, useRef, useState } from 'react'
import type { DraftSettings } from '../shared/protocol.js'
import { type DraftSettingsSnapshot, DraftSettingsStore } from './draft-settings-store.js'

/** Main owns the draft; renderer reloads must not change the next message's choices. */
export function useDraftSettings(
	owner: string,
	enabled: boolean,
	onError: (error: unknown) => void,
) {
	const [snapshots, setSnapshots] = useState<Record<string, DraftSettingsSnapshot>>({})
	const failure = useRef(onError)
	failure.current = onError
	const store = useRef<DraftSettingsStore | null>(null)
	if (!store.current)
		store.current = new DraftSettingsStore(
			(target) => window.namzu.draftSettings(target),
			(target, value) => window.namzu.saveDraftSettings(target, value),
			(target, value) => setSnapshots((all) => ({ ...all, [target]: value })),
			(error) => failure.current(error),
		)
	const state = store.current
	useEffect(() => {
		if (!enabled) return
		void state.load(owner)
		return () => state.cancelRead(owner)
	}, [enabled, owner, state])
	const get = useCallback((target: string) => state.get(target), [state])
	const save = useCallback(
		(target: string, value: DraftSettings) => state.save(target, value),
		[state],
	)
	const retry = useCallback(() => {
		if (enabled) void state.retry(owner).catch((error) => failure.current(error))
	}, [enabled, owner, state])
	const snapshot = snapshots[owner] ?? state.snapshot(owner)
	return {
		value: snapshot.value ?? {},
		loading: enabled && snapshot.loading,
		error: snapshot.error,
		retry,
		get,
		save,
	}
}
