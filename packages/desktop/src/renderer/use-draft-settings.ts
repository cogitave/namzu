import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DesktopApi, DraftSettings } from '../shared/protocol.js'
import { type DraftSettingsSnapshot, DraftSettingsStore } from './draft-settings-store.js'

/** Main owns the draft; renderer reloads must not change the next message's choices. */
export function useDraftSettings(
	owner: string,
	enabled: boolean,
	onError: (error: unknown) => void,
	api: DesktopApi = window.namzu,
) {
	const [snapshots, setSnapshots] = useState<{
		store: DraftSettingsStore | null
		values: Record<string, DraftSettingsSnapshot>
	}>({ store: null, values: {} })
	const failure = useRef(onError)
	useLayoutEffect(() => {
		failure.current = onError
	}, [onError])
	const activeOwner = useRef<{
		owner: string
		state: DraftSettingsStore
		active: boolean
	} | null>(null)
	// Constructing a candidate during render cannot retire the committed bridge:
	// React may abandon this render before it changes the visible owner or API.
	const state = useMemo(() => {
		const admittedApi = api
		const candidate = new DraftSettingsStore(
			async (target) => {
				const value = await admittedApi.draftSettings(target)
				if (activeOwner.current?.state !== candidate)
					throw new Error('This conversation’s message settings changed while loading. Try again.')
				return value
			},
			// A queued write retains the bridge that admitted it, even if a later
			// renderer API replaces that bridge before the write begins.
			(target, value) => admittedApi.saveDraftSettings(target, value),
			(target, value) => {
				if (activeOwner.current?.state !== candidate) return
				setSnapshots((all) => ({
					store: candidate,
					values: { ...(all.store === candidate ? all.values : {}), [target]: value },
				}))
			},
			(target, error) => {
				const lifetime = activeOwner.current
				if (lifetime?.owner === target && lifetime.state === candidate && lifetime.active)
					failure.current(error)
			},
		)
		return candidate
	}, [api])
	const lifetime = useMemo(() => ({ owner, state, active: false }), [owner, state])
	useLayoutEffect(() => {
		activeOwner.current = lifetime
		lifetime.active = true
		return () => {
			lifetime.active = false
			if (activeOwner.current === lifetime) {
				activeOwner.current = null
				state.cancelRead(owner)
			}
		}
	}, [owner, state, lifetime])
	useEffect(() => {
		if (!enabled) return
		void state.load(owner)
	}, [enabled, owner, state])
	const get = useCallback((target: string) => state.get(target), [state])
	const save = useCallback(
		(target: string, value: DraftSettings) => state.save(target, value),
		[state],
	)
	const refresh = useCallback((target: string) => state.reload(target), [state])
	const retry = useCallback(() => {
		if (enabled)
			void state.retry(owner).catch((error) => {
				if (activeOwner.current === lifetime && lifetime.active) failure.current(error)
			})
	}, [enabled, owner, state, lifetime])
	const snapshot =
		(snapshots.store === state ? snapshots.values[owner] : undefined) ?? state.snapshot(owner)
	return {
		value: snapshot.value ?? {},
		loading: enabled && snapshot.loading,
		error: snapshot.error,
		retry,
		get,
		save,
		refresh,
	}
}
