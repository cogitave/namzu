import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopApi, McpServersView } from '../shared/protocol.js'
import { waitingServers } from './mcp-servers-model.js'
import { plainErrorText } from './plain-error.js'

type Bridge = Pick<DesktopApi, 'mcpServers' | 'approveMcpServers'>

export interface McpServersControls {
	view?: McpServersView
	loading: boolean
	error?: string
	approving: boolean
	supported: boolean
	approve: () => Promise<void>
}

/** The open project's tool servers, read once when the page opens and again after an approval. */
export function useMcpServers(
	api: Bridge | undefined,
	projectId: string | undefined,
): McpServersControls {
	const [view, setView] = useState<McpServersView>()
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string>()
	const [approving, setApproving] = useState(false)
	const live = useRef(true)
	const supported = Boolean(api?.mcpServers && projectId)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])
	useEffect(() => {
		if (!api?.mcpServers || !projectId) {
			setView(undefined)
			setLoading(false)
			return
		}
		let current = true
		setLoading(true)
		api.mcpServers(projectId).then(
			(next) => {
				if (!current) return
				setView(next ?? undefined)
				setError(undefined)
				setLoading(false)
			},
			(failure) => {
				if (!current) return
				setError(plainErrorText(failure, 'read the tool servers'))
				setLoading(false)
			},
		)
		return () => {
			current = false
		}
	}, [api, projectId])
	const approve = useCallback(async () => {
		const shown = waitingServers(view)
		if (!api?.approveMcpServers || !projectId || shown.length === 0) return
		setApproving(true)
		try {
			const next = await api.approveMcpServers(projectId, shown)
			if (!live.current) return
			setView(next ?? undefined)
			setError(undefined)
		} catch (failure) {
			if (live.current) setError(plainErrorText(failure, 'approve the tool servers'))
		} finally {
			if (live.current) setApproving(false)
		}
	}, [api, projectId, view])
	return { view, loading, error, approving, supported, approve }
}
