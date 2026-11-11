import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

/** What was last read, and for which project: a list never shows under another project's name. */
export interface McpServersRead {
	projectId: string
	view?: McpServersView
	error?: string
	loading: boolean
}

/** The read that belongs to `projectId`, or nothing yet when the last one was for another project. */
export function readFor(
	read: McpServersRead | undefined,
	projectId: string | undefined,
): McpServersRead | undefined {
	return read && read.projectId === projectId ? read : undefined
}

/**
 * Reads a project's tool servers. Only the newest read may answer. A read for a project other than
 * the one on screen starts empty; a read of the same project (the window coming back into focus)
 * keeps what is shown until the answer replaces it.
 */
export class McpServersReader {
	private latest = 0
	private current: McpServersRead | undefined
	constructor(
		private readonly read: (projectId: string) => Promise<McpServersView | null>,
		private readonly publish: (read: McpServersRead) => void,
	) {}
	load(projectId: string): void {
		const mine = ++this.latest
		const same = this.current?.projectId === projectId
		this.set({
			projectId,
			loading: true,
			...(same && this.current?.view ? { view: this.current.view } : {}),
		})
		this.read(projectId).then(
			(next) => {
				if (this.latest === mine)
					this.set({ projectId, loading: false, ...(next ? { view: next } : {}) })
			},
			(failure) => {
				if (this.latest !== mine) return
				const keep = same && this.current?.view ? { view: this.current.view } : {}
				this.set({
					projectId,
					loading: false,
					error: plainErrorText(failure, 'read the tool servers'),
					...keep,
				})
			},
		)
	}
	/** An answer from elsewhere (an approval) replaces what is shown for that project. */
	replace(projectId: string, view: McpServersView | null): void {
		this.latest++
		this.set({ projectId, loading: false, ...(view ? { view } : {}) })
	}
	stop(): void {
		this.latest++
	}
	private set(next: McpServersRead): void {
		this.current = next
		this.publish(next)
	}
}

/** The open project's tool servers, read when the page opens, again when the window regains focus, and after an approval. */
export function useMcpServers(
	api: Bridge | undefined,
	projectId: string | undefined,
): McpServersControls {
	const [stored, setStored] = useState<McpServersRead>()
	const [approveError, setApproveError] = useState<string>()
	const [approving, setApproving] = useState(false)
	const live = useRef(true)
	const supported = Boolean(api?.mcpServers && projectId)
	const read = api?.mcpServers
	const reader = useMemo(
		() => (read ? new McpServersReader((id) => read(id), setStored) : undefined),
		[read],
	)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])
	useEffect(() => {
		setApproveError(undefined)
		if (!reader || !projectId) return
		reader.load(projectId)
		const refresh = () => reader.load(projectId)
		window.addEventListener('focus', refresh)
		return () => {
			window.removeEventListener('focus', refresh)
			reader.stop()
		}
	}, [reader, projectId])
	const shownRead = readFor(stored, projectId)
	const view = shownRead?.view
	const approve = useCallback(async () => {
		const shown = waitingServers(view)
		if (!api?.approveMcpServers || !projectId || !reader || shown.length === 0) return
		setApproving(true)
		setApproveError(undefined)
		try {
			const next = await api.approveMcpServers(projectId, shown)
			if (!live.current) return
			reader.replace(projectId, next ?? null)
		} catch (failure) {
			if (live.current) setApproveError(plainErrorText(failure, 'approve the tool servers'))
		} finally {
			if (live.current) setApproving(false)
		}
	}, [api, projectId, reader, view])
	return {
		view,
		loading: supported && (shownRead?.loading ?? true),
		error: approveError ?? shownRead?.error,
		approving,
		supported,
		approve,
	}
}
