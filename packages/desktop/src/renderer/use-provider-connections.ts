import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopApi, ProviderConnectionView, ProviderTestResult } from '../shared/protocol.js'

export interface ProviderConnectionsControls {
	rows: ProviderConnectionView[]
	loading: boolean
	error?: string
	/** The provider whose request is in flight. */
	busy?: string
	supported: boolean
	reload: () => void
	/** Resolves true when the key was saved. The key is not kept anywhere after this call. */
	save: (provider: string, apiKey: string) => Promise<boolean>
	remove: (provider: string) => Promise<boolean>
	test: (provider: string) => Promise<ProviderTestResult | undefined>
}

type Bridge = Pick<
	DesktopApi,
	'providerConnections' | 'saveProviderKey' | 'removeProviderKey' | 'testProvider'
>

/** The sentence a failure carries, without Electron's wrapper around it. */
export function plainFailure(failure: unknown): string {
	return failure instanceof Error && failure.message
		? failure.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
		: 'Something went wrong. Try again.'
}

export function useProviderConnections(
	api: Bridge | undefined,
	enabled: boolean,
): ProviderConnectionsControls {
	const [rows, setRows] = useState<ProviderConnectionView[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState<string>()
	const live = useRef(true)
	const supported = Boolean(api?.providerConnections && api.saveProviderKey)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])
	const load = useCallback(() => {
		if (!api?.providerConnections) return
		setLoading(true)
		api.providerConnections().then(
			(list) => {
				if (!live.current) return
				setRows(list)
				setError(undefined)
				setLoading(false)
			},
			(failure) => {
				if (!live.current) return
				setError(plainFailure(failure))
				setLoading(false)
			},
		)
	}, [api])
	useEffect(() => {
		if (enabled) load()
	}, [enabled, load])
	const run = useCallback(
		async <T>(provider: string, action: () => Promise<T>): Promise<T | undefined> => {
			setBusy(provider)
			setError(undefined)
			try {
				return await action()
			} catch (failure) {
				if (live.current) setError(plainFailure(failure))
				return undefined
			} finally {
				if (live.current) setBusy(undefined)
			}
		},
		[],
	)
	const unavailable = () => Promise.reject(new Error('Update Namzu to connect providers here.'))
	return {
		rows,
		loading,
		error,
		busy,
		supported,
		reload: load,
		save: async (provider, apiKey) => {
			const saved = await run(
				provider,
				() => api?.saveProviderKey?.(provider, apiKey) ?? unavailable(),
			)
			if (saved && live.current) setRows(saved)
			return Boolean(saved)
		},
		remove: async (provider) => {
			const left = await run(provider, () => api?.removeProviderKey?.(provider) ?? unavailable())
			if (left && live.current) setRows(left)
			return Boolean(left)
		},
		test: (provider) => run(provider, () => api?.testProvider?.(provider) ?? unavailable()),
	}
}
