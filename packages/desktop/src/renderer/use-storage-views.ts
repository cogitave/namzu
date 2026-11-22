import { useCallback, useEffect, useState } from 'react'
import type { DesktopApi } from '../shared/protocol.js'
import type {
	StoragePartId,
	StorageReport,
	TrustedFoldersView,
} from '../shared/storage-protocol.js'

/** A readable sentence for a failure from main, never a stack. */
function plain(failure: unknown, fallback: string): string {
	return failure instanceof Error && failure.message ? failure.message : fallback
}

export interface StorageControls {
	report?: StorageReport
	error?: string
	busy: boolean
	clear: (id: StoragePartId) => Promise<void>
}

/** The sizes by part, measured when `active` turns on (the view is opened) and after each clear. */
export function useStorageUsage(
	api: Pick<DesktopApi, 'storageUsage' | 'clearStorage'> | undefined,
	active: boolean,
): StorageControls {
	const [report, setReport] = useState<StorageReport>()
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	useEffect(() => {
		if (!active || !api?.storageUsage) return
		let live = true
		setBusy(true)
		setError(undefined)
		api
			.storageUsage()
			.then((value) => live && setReport(value))
			.catch((failure) => live && setError(plain(failure, 'The sizes could not be read.')))
			.finally(() => live && setBusy(false))
		return () => {
			live = false
		}
	}, [api, active])
	const clear = useCallback(
		async (id: StoragePartId) => {
			if (!api?.clearStorage) return
			setBusy(true)
			setError(undefined)
			try {
				setReport(await api.clearStorage(id))
			} catch (failure) {
				setError(plain(failure, 'That could not be cleared.'))
			} finally {
				setBusy(false)
			}
		},
		[api],
	)
	return { report, error, busy, clear }
}

export interface TrustedFoldersControls {
	view?: TrustedFoldersView
	error?: string
	busy: boolean
	remove: (path: string) => Promise<void>
	/** Only while the list cannot be read: an empty list in its place, the old one kept. */
	startNew: () => Promise<void>
}

/** The folders the engine trusts, read when `active` turns on. */
export function useTrustedFolders(
	api:
		| Pick<DesktopApi, 'trustedFolders' | 'removeTrustedFolder' | 'startNewTrustedFolders'>
		| undefined,
	active: boolean,
): TrustedFoldersControls {
	const [view, setView] = useState<TrustedFoldersView>()
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	useEffect(() => {
		if (!active || !api?.trustedFolders) return
		let live = true
		setError(undefined)
		api
			.trustedFolders()
			.then((value) => live && setView(value))
			.catch((failure) => live && setError(plain(failure, 'The list could not be read.')))
		return () => {
			live = false
		}
	}, [api, active])
	const remove = useCallback(
		async (path: string) => {
			if (!api?.removeTrustedFolder) return
			setBusy(true)
			setError(undefined)
			try {
				setView(await api.removeTrustedFolder(path))
			} catch (failure) {
				setError(plain(failure, 'That folder could not be removed.'))
				// The list may have changed under the view: read it again.
				void api.trustedFolders?.().then(setView, () => undefined)
			} finally {
				setBusy(false)
			}
		},
		[api],
	)
	const startNew = useCallback(async () => {
		if (!api?.startNewTrustedFolders) return
		setBusy(true)
		setError(undefined)
		try {
			setView(await api.startNewTrustedFolders())
		} catch (failure) {
			setError(plain(failure, 'A new list could not be started. Nothing was changed.'))
			void api.trustedFolders?.().then(setView, () => undefined)
		} finally {
			setBusy(false)
		}
	}, [api])
	return { view, error, busy, remove, startNew }
}
