import { useCallback, useEffect, useRef, useState } from 'react'
import type {
	UserMcpServerChange,
	UserMcpServerView,
	UserMcpServersView,
} from '../shared/config-lists-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { plainErrorText } from './plain-error.js'

type Bridge = Pick<
	DesktopApi,
	'userMcpServers' | 'userMcpServer' | 'saveUserMcpServer' | 'removeUserMcpServer'
>

export interface UserServerConfirmation {
	change: UserMcpServerChange
	token: string
	message: string
}

export interface UserMcpServersControls {
	view?: UserMcpServersView
	/** The last failure, in words. */
	error?: string
	busy: boolean
	confirmation?: UserServerConfirmation
	/** Saves; true once the engine took it. A command asks first and answers false until confirmed. */
	save: (change: UserMcpServerChange) => Promise<boolean>
	confirm: () => Promise<boolean>
	dismiss: () => void
	remove: (name: string) => Promise<boolean>
	/** One server whole (arguments and address), read only when its edit form opens. */
	open: (name: string) => Promise<UserMcpServerView | undefined>
	clearError: () => void
}

/**
 * The tool servers in the person's own config file, read when the page opens and again when the
 * window regains focus. `changed` runs after a save or a removal, so the project's list reads again.
 */
export function useUserMcpServers(
	api: Partial<Bridge> | undefined,
	changed?: () => void,
): UserMcpServersControls | undefined {
	const [view, setView] = useState<UserMcpServersView>()
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	const [confirmation, setConfirmation] = useState<UserServerConfirmation>()
	const live = useRef(true)
	const read = api?.userMcpServers
	const write = api?.saveUserMcpServer
	const drop = api?.removeUserMcpServer
	const one = api?.userMcpServer
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])
	useEffect(() => {
		if (!read) return
		let current = true
		const load = () =>
			read().then(
				(next) => current && setView(next),
				(failure) => current && setError(plainErrorText(failure, 'read your tool servers')),
			)
		void load()
		window.addEventListener('focus', load)
		return () => {
			current = false
			window.removeEventListener('focus', load)
		}
	}, [read])
	const apply = useCallback(async (run: () => Promise<boolean>, what: string) => {
		setBusy(true)
		setError(undefined)
		try {
			return await run()
		} catch (failure) {
			if (live.current) setError(plainErrorText(failure, what))
			return false
		} finally {
			if (live.current) setBusy(false)
		}
	}, [])
	const save = useCallback(
		(change: UserMcpServerChange) =>
			apply(async () => {
				if (!write) return false
				const result = await write(change)
				if (!live.current) return false
				if (result.status === 'confirm') {
					setConfirmation({ change, token: result.token, message: result.message })
					return false
				}
				setView(result.view)
				changed?.()
				return true
			}, 'save the tool server'),
		[apply, write, changed],
	)
	const confirm = useCallback(async () => {
		if (!confirmation || !write) return false
		const { change, token } = confirmation
		const result = await write(change, token)
		if (!live.current || result.status !== 'saved') return false
		setConfirmation(undefined)
		setView(result.view)
		changed?.()
		return true
	}, [confirmation, write, changed])
	const remove = useCallback(
		(name: string) =>
			apply(async () => {
				if (!drop) return false
				const next = await drop(name)
				if (!live.current) return false
				setView(next)
				changed?.()
				return true
			}, 'remove the tool server'),
		[apply, drop, changed],
	)
	const open = useCallback(
		async (name: string) => {
			if (!one) return undefined
			setError(undefined)
			try {
				return await one(name)
			} catch (failure) {
				if (live.current) setError(plainErrorText(failure, 'read the tool server'))
				return undefined
			}
		},
		[one],
	)
	if (!read || !write || !drop || !one) return undefined
	return {
		view,
		error,
		busy,
		confirmation,
		save,
		confirm,
		dismiss: () => setConfirmation(undefined),
		remove,
		open,
		clearError: () => setError(undefined),
	}
}
