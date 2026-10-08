import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopApi } from '../shared/protocol.js'
import type { DesktopInfo, DesktopSettings } from '../shared/settings-protocol.js'
import type { UpdateInfo, UpdateState } from '../shared/update-protocol.js'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface DesktopSettingsControls {
	/** Undefined until main answers; the page shows a quiet placeholder meanwhile. */
	settings: DesktopSettings | undefined
	error: string
	change: (patch: Partial<DesktopSettings>) => Promise<void>
	/** Set while main wants the person to confirm a change that lowers a safeguard. */
	confirmation: SettingsConfirmationRequest | undefined
	/** Resends the pending change with main's token. Rejects when main refuses it. */
	confirm: () => Promise<void>
	dismiss: () => void
}

export interface SettingsConfirmationRequest {
	patch: Partial<DesktopSettings>
	token: string
}

/**
 * Main's saved preferences, read when `active` first turns on and kept in step by the
 * `settings` event any window's change produces. A change shows at once and is corrected if
 * main refuses it.
 */
export function useDesktopSettings(
	api: Pick<DesktopApi, 'settings' | 'setSettings' | 'onEvent'>,
	active: boolean,
): DesktopSettingsControls {
	const [settings, setSettings] = useState<DesktopSettings>()
	const [error, setError] = useState('')
	const writes = useRef(0)
	const [confirmation, setConfirmation] = useState<SettingsConfirmationRequest>()
	useEffect(() => {
		if (!active || !api.settings) return
		let live = true
		void api
			.settings()
			.then((value) => {
				if (live) setSettings((current) => current ?? value)
			})
			.catch((failure) => live && setError(message(failure)))
		const stop = api.onEvent((event) => {
			if (event.kind === 'settings' && live) setSettings(event.settings)
		})
		return () => {
			live = false
			stop()
		}
	}, [api, active])
	const change = useCallback(
		async (patch: Partial<DesktopSettings>) => {
			if (!api.setSettings) return
			setError('')
			const write = ++writes.current
			setSettings((current) => (current ? { ...current, ...patch } : current))
			try {
				const result = await api.setSettings(patch)
				if (write === writes.current) setSettings(result.settings)
				if (result.status === 'confirm') setConfirmation({ patch, token: result.token })
			} catch (failure) {
				setError(message(failure))
				try {
					const actual = await api.settings?.()
					if (actual && write === writes.current) setSettings(actual)
				} catch {
					/* The original failure is the one to show. */
				}
			}
		},
		[api],
	)
	const confirm = useCallback(async () => {
		if (!confirmation || !api.setSettings) return
		// A refusal (an expired token) throws to the dialog, which shows it and stays open.
		const result = await api.setSettings(confirmation.patch, confirmation.token)
		setSettings(result.settings)
		setConfirmation(undefined)
	}, [api, confirmation])
	const dismiss = useCallback(() => setConfirmation(undefined), [])
	return {
		settings,
		error,
		change,
		confirmation,
		confirm,
		dismiss,
	}
}

/** Version, folders and notices; read once when About first needs them. */
export function useDesktopInfo(api: Pick<DesktopApi, 'desktopInfo'>, active: boolean) {
	const [info, setInfo] = useState<DesktopInfo>()
	const [error, setError] = useState('')
	useEffect(() => {
		if (!active || info || !api.desktopInfo) return
		let live = true
		void api
			.desktopInfo()
			.then((value) => live && setInfo(value))
			.catch((failure) => live && setError(message(failure)))
		return () => {
			live = false
		}
	}, [api, active, info])
	return { info, error }
}

/** The running version and last check time, re-read whenever the update state moves. */
export function useUpdateInfo(
	api: Pick<DesktopApi, 'updateInfo'>,
	state: UpdateState,
	active: boolean,
): UpdateInfo | undefined {
	const [info, setInfo] = useState<UpdateInfo>()
	// biome-ignore lint/correctness/useExhaustiveDependencies: a state change is the reason to re-read.
	useEffect(() => {
		if (!active || !api.updateInfo) return
		let live = true
		void api
			.updateInfo()
			.then((value) => live && setInfo(value))
			.catch(() => {})
		return () => {
			live = false
		}
	}, [api, active, state])
	return info
}
