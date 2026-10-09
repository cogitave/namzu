import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceAction, WorkspaceView } from '../shared/protocol.js'
import { isTerminalTabId } from '../shared/terminal-tabs.js'
import { workspaceGroups } from '../shared/workspace-layout.js'
import type { WorkspaceWindowBounds } from '../shared/workspace-layout.js'
import { App } from './app.js'
import type { Appearance } from './sidebar.js'
import { adoptBoot } from './startup-restore.js'
import { rememberConversation, splitTerminalGroup } from './terminal-group.js'
import { terminalApi, terminalSessions } from './terminal-registry.js'
import { useTerminalTabs } from './terminal-store.js'
import { UpdateDialog } from './update-dialog.js'
import { type UpdateDialogAction, updateDialogModel } from './update-model.js'
import { EngineUpdatesContext, useEngineUpdatesController } from './use-engine-updates.js'
import { useUpdateBusyReporter, useUpdateState } from './use-update.js'
import type { WorkspaceTabDrag } from './workspace-canvas-geometry.js'
import { WorkspaceCanvas } from './workspace-canvas.js'
import type { WorkspacePaneController } from './workspace-pane-types.js'
import './workspace-host.css'

const api = window.namzu
// Before anything renders, so the first render of every pane can seed from the snapshot.
adoptBoot(api?.boot)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The shell belongs to the native window; each stable leaf owns one conversation controller. */
export function WorkspaceHost() {
	const [view, setView] = useState<WorkspaceView | undefined>(() => api?.boot?.workspace)
	const current = useRef(view)
	current.current = view
	const [shell, setShell] = useState<HTMLDivElement | null>(null)
	const [page, setPage] = useState('chat')
	const [error, setError] = useState('')
	const [localFocus, setLocalFocus] = useState<string>()
	const controllers = useRef(new Map<string, WorkspacePaneController>())
	const terminalTabs = useTerminalTabs(api)
	// The conversation in front of each pane before a terminal came to the front.
	const lastConversation = useRef(new Map<string, string>())
	const localMoves = useRef(new Set<string>())
	const acknowledging = useRef(new Set<string>())
	// "Start on the home screen": the saved tab stays in its strip, but this launch does not
	// open it until the person picks one.
	const [startAtHome, setStartAtHome] = useState(
		() => api?.boot?.launch === true && api.boot.settings.startup === 'home',
	)
	const [appearance, setAppearance] = useState<Appearance>(() => {
		const saved = localStorage.getItem('namzu.appearance')
		return saved === 'light' || saved === 'system' ? saved : 'dark'
	})
	const [sideCollapsed, setSideCollapsed] = useState(
		() => localStorage.getItem('namzu.sidebar-collapsed') === 'true',
	)
	const accept = useCallback((next: WorkspaceView) => {
		if (current.current && next.sequence < current.current.sequence) return
		current.current = next
		setView(next)
		setLocalFocus(undefined)
	}, [])
	const report = useCallback((failure: unknown) => setError(message(failure)), [])
	const updateState = useUpdateState(api)
	const engineUpdates = useEngineUpdatesController(api, report)
	const [updateOpen, setUpdateOpen] = useState(false)
	const updateDialogShown = updateOpen || updateState.status === 'installing'
	useEffect(() => {
		if (!updateDialogModel(updateState)) setUpdateOpen(false)
	}, [updateState])
	useUpdateBusyReporter(api, updateState.status !== 'disabled')
	const updateAction = (action: UpdateDialogAction) => {
		if (action === 'restart' || action === 'retry') void api.installUpdate?.().catch(report)
		else if (action === 'download') void api.downloadUpdate?.().catch(report)
		else if (action === 'later') {
			void api.cancelUpdateInstall?.().catch(report)
			setUpdateOpen(false)
		} else setUpdateOpen(false)
	}
	const update =
		api.updateState === undefined
			? undefined
			: {
					state: updateState,
					onOpen: () => setUpdateOpen(true),
					onCheck: () => void api.checkForUpdate?.().catch(report),
					onDownload: () => void api.downloadUpdate?.().catch(report),
				}
	const keyboardCapture = useRef<boolean | null>(null)
	const syncComputerFocus = useCallback(() => {
		const active =
			document.activeElement instanceof Element
				? document.activeElement.closest<HTMLElement>('.pal-computer-screen')
				: null
		const pane = active?.closest<HTMLElement>('main.workspace')
		const enabled =
			document.hasFocus() && active?.dataset.interactive === 'true' && !!pane && !pane.inert
		if (keyboardCapture.current === enabled) return
		keyboardCapture.current = enabled
		void api.setComputerKeyboardCapture?.(enabled).catch(report)
	}, [report])
	useEffect(() => {
		document.addEventListener('focusin', syncComputerFocus)
		window.addEventListener('focus', syncComputerFocus)
		window.addEventListener('blur', syncComputerFocus)
		return () => {
			document.removeEventListener('focusin', syncComputerFocus)
			window.removeEventListener('focus', syncComputerFocus)
			window.removeEventListener('blur', syncComputerFocus)
		}
	}, [syncComputerFocus])
	const refresh = useCallback(async () => {
		if (!api.workspace) throw new Error('Restart the desktop app to open conversation panes.')
		accept(await api.workspace())
	}, [accept])
	useEffect(() => {
		void refresh().catch(report)
		return api.onEvent((event) => {
			if (event.kind === 'workspace') accept(event.view)
		})
	}, [accept, refresh, report])
	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)')
		const apply = () =>
			document.documentElement.classList.toggle(
				'dark',
				appearance === 'dark' || (appearance === 'system' && media.matches),
			)
		apply()
		localStorage.setItem('namzu.appearance', appearance)
		media.addEventListener('change', apply)
		return () => media.removeEventListener('change', apply)
	}, [appearance])
	useEffect(() => {
		const update = (event: StorageEvent) => {
			if (
				event.key === 'namzu.appearance' &&
				(event.newValue === 'dark' || event.newValue === 'light' || event.newValue === 'system')
			)
				setAppearance(event.newValue)
			if (event.key === 'namzu.sidebar-collapsed') setSideCollapsed(event.newValue === 'true')
		}
		window.addEventListener('storage', update)
		return () => window.removeEventListener('storage', update)
	}, [])
	const action = useCallback(
		async (value: WorkspaceAction) => {
			if (!api.workspaceAction)
				throw new Error('Restart the desktop app to move conversation tabs.')
			// Choosing a tab ends the home-screen start; the choice is the person's.
			if (value.kind === 'activate' || value.kind === 'open') setStartAtHome(false)
			try {
				if (value.kind === 'close') {
					localMoves.current.add(value.groupId)
					await controllers.current.get(value.groupId)?.prepare()
				}
				const next = await api.workspaceAction(value)
				accept(next)
				return next
			} finally {
				if (value.kind === 'close') {
					localMoves.current.delete(value.groupId)
					controllers.current.get(value.groupId)?.resume()
				}
			}
		},
		[accept],
	)
	const register = useCallback((id: string, controller: WorkspacePaneController) => {
		controllers.current.set(id, controller)
		return () => {
			if (controllers.current.get(id) === controller) controllers.current.delete(id)
		}
	}, [])
	const prepare = useCallback(async (source: WorkspaceTabDrag) => {
		if (source.windowId !== current.current?.windowId) return // Source window receives its own authenticated preparation event.
		const controller = controllers.current.get(source.groupId)
		if (!controller) throw new Error('This conversation is still opening. Try moving it again.')
		if (!current.current?.outgoingTransfer) localMoves.current.add(source.groupId)
		try {
			await controller.prepare()
		} catch (error) {
			localMoves.current.delete(source.groupId)
			controller.resume()
			throw error
		}
	}, [])
	const cancelTransfer = useCallback(
		async (id: string, failure: unknown) => {
			report(failure)
			try {
				await action({ kind: 'cancel-transfer', transferId: id })
			} catch (error) {
				report(error)
			}
		},
		[action, report],
	)
	useEffect(() => {
		const outgoing = view?.outgoingTransfer
		if (!outgoing || outgoing.prepared || acknowledging.current.has(outgoing.id)) return
		const layout = view.layout.windows.find((item) => item.id === view.windowId)
		const group = workspaceGroups(layout?.root ?? null).find((item) =>
			item.tabs.includes(outgoing.tabId),
		)
		if (!group) return
		acknowledging.current.add(outgoing.id)
		void prepare({ windowId: view.windowId, groupId: group.id, tabId: outgoing.tabId })
			.then(async () => {
				if (!api.workspaceReady) throw new Error('This window cannot prepare a conversation.')
				accept(await api.workspaceReady(outgoing.id))
			})
			.catch((failure) => cancelTransfer(outgoing.id, failure))
			.finally(() => acknowledging.current.delete(outgoing.id))
	}, [view, prepare, accept, cancelTransfer])
	useEffect(() => {
		const outgoing = view?.outgoingTransfer
		for (const [id, controller] of controllers.current) {
			const layout = view?.layout.windows.find((item) => item.id === view.windowId)
			const ownsOutgoing = workspaceGroups(layout?.root ?? null).some(
				(group) => group.id === id && group.tabs.includes(outgoing?.tabId ?? ''),
			)
			if (!ownsOutgoing && !view?.closingWindow && !localMoves.current.has(id)) controller.resume()
		}
	}, [view])
	useEffect(() => {
		const closing = view?.closingWindow
		if (!closing || acknowledging.current.has(closing.id)) return
		acknowledging.current.add(closing.id)
		void Promise.all([...controllers.current.values()].map((controller) => controller.prepare()))
			.then(async () => {
				if (!api.workspaceCloseReady) throw new Error('This window cannot close safely.')
				await api.workspaceCloseReady(closing.id)
			})
			.catch(async (failure) => {
				report(failure)
				try {
					await action({ kind: 'cancel-close', closeId: closing.id })
				} catch (error) {
					report(error)
				}
			})
			.finally(() => acknowledging.current.delete(closing.id))
	}, [view, action, report])
	const ready = useCallback(
		(groupId: string, sessionId: string) => {
			const pending = current.current?.pendingTransfer
			if (
				!pending ||
				!pending.sourcePrepared ||
				pending.tabId !== sessionId ||
				acknowledging.current.has(pending.id)
			)
				return
			if (
				!workspaceGroups(pending.previewRoot).some(
					(group) => group.id === groupId && group.activeTabId === sessionId,
				)
			)
				return
			acknowledging.current.add(pending.id)
			void Promise.resolve()
				.then(async () => {
					if (!api.workspaceReady) throw new Error('This window cannot receive a conversation.')
					accept(await api.workspaceReady(pending.id))
				})
				.catch((failure) => cancelTransfer(pending.id, failure))
				.finally(() => acknowledging.current.delete(pending.id))
		},
		[accept, cancelTransfer],
	)
	// A terminal arrives with nothing to load: it is ready as soon as it is in front.
	useEffect(() => {
		const incoming = view?.pendingTransfer
		if (!incoming || !incoming.sourcePrepared || !isTerminalTabId(incoming.tabId)) return
		const group = workspaceGroups(incoming.previewRoot).find(
			(item) => item.activeTabId === incoming.tabId,
		)
		if (group) ready(group.id, incoming.tabId)
	}, [view, ready])
	const loadFailure = useCallback(
		(sessionId: string, failure: unknown) => {
			const pending = current.current?.pendingTransfer
			if (pending?.tabId === sessionId) void cancelTransfer(pending.id, failure)
		},
		[cancelTransfer],
	)
	const detach = useCallback(
		(groupId: string, tabId: string, bounds?: WorkspaceWindowBounds) => {
			const owner = current.current
			if (!owner) return
			setError('')
			void prepare({ windowId: owner.windowId, groupId, tabId })
				.then(() =>
					action({ kind: 'detach', sourceGroupId: groupId, tabId, ...(bounds ? { bounds } : {}) }),
				)
				.catch(report)
				.finally(() => {
					localMoves.current.delete(groupId)
					if (!current.current?.outgoingTransfer) controllers.current.get(groupId)?.resume()
				})
		},
		[action, prepare, report],
	)
	const split = useCallback(
		(groupId: string, tabId: string, position: 'right' | 'bottom') => {
			const owner = current.current
			if (!owner) return
			const canvas = document.querySelector<HTMLElement>('.workspace-canvas')
			void prepare({ windowId: owner.windowId, groupId, tabId })
				.then(() =>
					action({
						kind: 'move',
						sourceWindowId: owner.windowId,
						sourceGroupId: groupId,
						targetWindowId: owner.windowId,
						targetGroupId: groupId,
						tabId,
						position,
						size: { width: canvas?.clientWidth ?? 0, height: canvas?.clientHeight ?? 0 },
					}),
				)
				.catch(report)
				.finally(() => {
					localMoves.current.delete(groupId)
					controllers.current.get(groupId)?.resume()
				})
		},
		[action, prepare, report],
	)
	const paneFocus = useCallback(
		(groupId: string) => {
			const owner = current.current
			if (!owner || owner.pendingTransfer) return
			const windowLayout = owner.layout.windows.find((item) => item.id === owner.windowId)
			setLocalFocus(groupId)
			if (windowLayout?.root && windowLayout.focusedGroupId !== groupId)
				void action({ kind: 'focus', groupId }).catch(report)
		},
		[action, report],
	)
	const shellState = useCallback((state: { page: string }) => setPage(state.page), [])
	const canonical = view?.layout.windows.find((item) => item.id === view.windowId)
	const pending = view?.pendingTransfer
	const preview =
		canonical && pending?.sourcePrepared ? { ...canonical, root: pending.previewRoot } : canonical
	const groups = workspaceGroups(preview?.root ?? null)
	// A terminal's view lives as long as its tab is in this window; one that left takes its view with it.
	const terminalIdsHere = groups
		.flatMap((group) => group.tabs)
		.filter(isTerminalTabId)
		.join(' ')
	useEffect(() => {
		if (!view) return
		const bridge = terminalApi(api)
		if (!bridge) return
		terminalSessions(bridge).retain(new Set(terminalIdsHere ? terminalIdsHere.split(' ') : []))
	}, [view, terminalIdsHere])
	const incomingGroup = pending && groups.find((group) => group.tabs.includes(pending.tabId))
	const focused =
		incomingGroup?.id ??
		(groups.some((group) => group.id === localFocus) ? localFocus : preview?.focusedGroupId) ??
		view?.homeGroupId
	const activeFrozen =
		!!view?.closingWindow ||
		!!pending ||
		(!!view?.outgoingTransfer &&
			groups.some(
				(group) => group.id === focused && group.tabs.includes(view.outgoingTransfer?.tabId ?? ''),
			))
	const content = (
		<div className="app workspace-host" data-sidebar-collapsed={sideCollapsed} data-page={page}>
			<div ref={setShell} className="workspace-shell" inert={activeFrozen} />
			<div className="workspace-stage">
				{error && (
					<div className="workspace-window-error" role="alert">
						<span>{error}</span>
						<button
							type="button"
							onClick={() => {
								setError('')
								void refresh().catch(report)
							}}
						>
							Try again
						</button>
					</div>
				)}
				{view && preview && (
					<WorkspaceCanvas
						windowLayout={{ ...preview, focusedGroupId: focused ?? null }}
						emptyGroupId={view.homeGroupId}
						onPaneFocus={paneFocus}
						onAction={async (value) => {
							try {
								return await action(value)
							} finally {
								if (
									value.kind === 'move' &&
									(!value.sourceWindowId || value.sourceWindowId === view.windowId)
								) {
									localMoves.current.delete(value.sourceGroupId)
									controllers.current.get(value.sourceGroupId)?.resume()
								}
							}
						}}
						onPrepareMove={prepare}
						onError={report}
						busy={!!view.closingWindow || !!pending || !!view.outgoingTransfer}
						renderPane={(pane) => {
							const remembered = rememberConversation(lastConversation.current.get(pane.id), pane)
							if (remembered) lastConversation.current.set(pane.id, remembered)
							else lastConversation.current.delete(pane.id)
							const parts = splitTerminalGroup(pane, remembered)
							const group = parts.group
							return (
								<App
									group={group}
									terminals={
										api.openTerminal
											? {
													tabs: terminalTabs,
													order: parts.order,
													...(parts.activeTerminalId ? { activeId: parts.activeTerminalId } : {}),
												}
											: undefined
									}
									windowId={view.windowId}
									focused={focused === group.id}
									shell={shell}
									frozen={
										!!view.closingWindow ||
										!!pending ||
										(!!view.outgoingTransfer && group.tabs.includes(view.outgoingTransfer.tabId))
									}
									appearance={appearance}
									startAtHome={startAtHome}
									update={update}
									onAppearanceChange={setAppearance}
									sideCollapsed={sideCollapsed}
									onSideCollapsedChange={setSideCollapsed}
									onShellState={shellState}
									onAction={action}
									registerController={register}
									onReady={ready}
									onLoadFailure={loadFailure}
									onComputerFocus={syncComputerFocus}
									onDetach={detach}
									onSplit={split}
								/>
							)
						}}
					/>
				)}
			</div>
			{updateDialogShown && (
				<UpdateDialog
					state={updateState}
					onAction={updateAction}
					onClose={() => setUpdateOpen(false)}
					returnFocus={() => document.querySelector<HTMLElement>('.rail-profile-button')}
				/>
			)}
		</div>
	)
	return (
		<EngineUpdatesContext.Provider value={engineUpdates}>{content}</EngineUpdatesContext.Provider>
	)
}
