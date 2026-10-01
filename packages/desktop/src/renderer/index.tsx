import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type ThreadState, applyEvent, emptyThread, restoreMessages } from '../shared/projection.js'
import type {
	ComposerModelSettings,
	ConversationView,
	DesktopEvent,
	JobView,
	ProjectView,
	ProviderView,
} from '../shared/protocol.js'
import { AttachmentList } from './attachment-list.js'
import { ChangedFilesCard } from './changed-files-card.js'
import { ChangesPanel } from './changes-panel.js'
import { ChatErrorBanner } from './chat-error-banner.js'
import { CommandPalette, type CommandPaletteItem } from './command-palette.js'
import type { ComposerPluginInventory } from './composer-plugins.js'
import { Composer } from './composer.js'
import {
	ArrowUpIcon,
	FileDiffIcon,
	FolderIcon,
	PanelLeftIcon,
	PlusIcon,
	SquareIcon,
	SquarePenIcon,
	TerminalIcon,
	WrenchIcon,
	XIcon,
} from './icons.js'
import { Message, MessageContent } from './message.js'
import { NavigationRail } from './navigation-rail.js'
import { ProjectContextCard, ProjectContextMenu } from './project-context.js'
import { type Appearance, Sidebar } from './sidebar.js'
import { ToolView } from './tool-view.js'
import { Button } from './ui/button.js'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty.js'
import { TooltipProvider } from './ui/tooltip.js'
import { useAttachments } from './use-attachments.js'
import { useDraftSettings } from './use-draft-settings.js'
import { WindowTitlebar } from './window-titlebar.js'
import { Wordmark } from './wordmark.js'
import {
	WorkspaceBreadcrumb,
	WorkspaceBreadcrumbItem,
	WorkspaceBreadcrumbSeparator,
	WorkspaceBreadcrumbText,
} from './workspace-breadcrumb.js'
import { WorkspacePageHeader } from './workspace-page-header.js'

import './style.css'

const api = window.namzu
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
function Icon({ name }: { name: 'folder' | 'plus' | 'menu' | 'arrow' | 'stop' | 'close' }) {
	const Component = {
		folder: FolderIcon,
		plus: PlusIcon,
		menu: PanelLeftIcon,
		arrow: ArrowUpIcon,
		stop: SquareIcon,
		close: XIcon,
	}[name]
	return <Component aria-hidden="true" />
}
function ToolRow({ tool, active }: { tool: ThreadState['tools'][string]; active: boolean }) {
	const Icon =
		tool.view.kind === 'terminal' || tool.title === 'bash'
			? TerminalIcon
			: tool.view.kind === 'diff'
				? FileDiffIcon
				: WrenchIcon
	return (
		<details
			className={`tool ${tool.status} ${active ? 'active' : ''}`}
			data-tool-call-id={tool.toolCallId}
		>
			<summary>
				<span className="tool-icon flex size-6 shrink-0 items-center justify-center">
					<Icon className="size-4" aria-hidden="true" />
				</span>
				<span>{tool.view.kind === 'generic' ? tool.view.label : tool.title}</span>
				<span className="tool-status">
					{tool.status === 'pending'
						? active
							? 'Working'
							: 'Interrupted'
						: tool.status === 'failed'
							? 'Failed'
							: 'Done'}
				</span>
			</summary>
			<ToolView view={tool.view} />
			{tool.progress && (
				<output className="tool-progress">
					{tool.progress.message}
					{tool.progress.fraction !== undefined && (
						<progress value={tool.progress.fraction} max={1} />
					)}
				</output>
			)}
		</details>
	)
}
function App() {
	const [projects, setProjects] = useState<ProjectView[]>([])
	const [projectId, setProjectId] = useState('')
	const [conversations, setConversations] = useState<ConversationView[]>([])
	const [sessionId, setSessionId] = useState('')
	const [navigationHistory, setNavigationHistory] = useState<{
		entries: { projectId: string; sessionId: string }[]
		index: number
	}>({ entries: [], index: -1 })
	const historyReplay = useRef<string | null>(null)
	const historyBusy = useRef(false)
	const [historyLoading, setHistoryLoading] = useState(false)
	useEffect(() => {
		if (!projectId) return
		const key = `${projectId}/${sessionId}`
		const replay = historyReplay.current === key
		historyReplay.current = null
		setNavigationHistory((previous) => {
			const current = previous.entries[previous.index]
			if (replay || (current?.projectId === projectId && current.sessionId === sessionId))
				return previous
			const entries = [
				...previous.entries.slice(0, previous.index + 1),
				{ projectId, sessionId },
			].slice(-100)
			return { entries, index: entries.length - 1 }
		})
	}, [projectId, sessionId])
	const [threads, setThreads] = useState<Record<string, ThreadState>>({})
	const threadsRef = useRef(threads)
	threadsRef.current = threads
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const draftsRef = useRef<Record<string, string>>({})
	const navigation = useRef(0)
	const snapshotRead = useRef<{
		generation: number
		sessionId: string
		events: DesktopEvent[]
		characters: number
		overflow: boolean
	} | null>(null)
	const activeSession = useRef('')
	activeSession.current = sessionId
	const editingQueue = useRef(new Set<string>())
	const [queueEditing, setQueueEditing] = useState<Record<string, boolean>>({})
	const [providers, setProviders] = useState<ProviderView>({
		available: [],
		selected: null,
	})
	const [providerProjectId, setProviderProjectId] = useState('')
	const [modelSettings, setModelSettings] = useState<{
		key: string
		value: ComposerModelSettings
	} | null>(null)
	const [pluginStates, setPluginStates] = useState<
		Record<string, { loading: boolean; value?: ComposerPluginInventory }>
	>({})
	const [sideOpen, setSideOpen] = useState(false)
	const [commandOpen, setCommandOpen] = useState(false)
	const commandTrigger = useRef<HTMLElement | null>(null)
	const commandRead = useRef(0)
	const [commandListing, setCommandListing] = useState({ loading: false, notice: '' })
	const openCommands = useCallback(() => {
		commandTrigger.current =
			document.activeElement instanceof HTMLElement ? document.activeElement : null
		setCommandOpen(true)
	}, [])
	const refreshCommands = useCallback(() => {
		if (!api) return
		const generation = ++commandRead.current
		const readable = projects.filter((item) => item.trusted && item.status === 'ready')
		setCommandListing({ loading: true, notice: '' })
		void Promise.allSettled(readable.map((item) => api.conversations(item.id))).then((results) => {
			if (generation !== commandRead.current) return
			setConversations((previous) => {
				const catalogue = new Map(previous.map((view) => [view.id, view]))
				for (const result of results) {
					if (result.status !== 'fulfilled') continue
					for (const view of result.value) catalogue.set(view.id, view)
				}
				return [...catalogue.values()]
			})
			const partial =
				readable.length < projects.length || results.some((result) => result.status === 'rejected')
			setCommandListing({
				loading: false,
				notice: partial ? 'Some conversations could not be loaded.' : '',
			})
		})
	}, [projects])
	useEffect(() => {
		if (!commandOpen) return
		refreshCommands()
		return () => {
			commandRead.current += 1
		}
	}, [commandOpen, refreshCommands])
	const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
	useEffect(() => {
		const media = window.matchMedia('(max-width: 767px)')
		const update = () => {
			setMobile(media.matches)
			if (!media.matches) setSideOpen(false)
		}
		media.addEventListener('change', update)
		return () => media.removeEventListener('change', update)
	}, [])
	const previousSideOpen = useRef(sideOpen)
	useEffect(() => {
		const wasOpen = previousSideOpen.current
		previousSideOpen.current = sideOpen
		if (!wasOpen || sideOpen || !mobile) return
		const focused = document.activeElement
		if (
			focused === document.body ||
			(focused instanceof HTMLElement && focused.closest('#namzu-sidebar'))
		)
			document
				.querySelector<HTMLButtonElement>('button[aria-label="Toggle sidebar"]')
				?.focus({ preventScroll: true })
	}, [sideOpen, mobile])
	const [sideCollapsed, setSideCollapsed] = useState(
		() => localStorage.getItem('namzu.sidebar-collapsed') === 'true',
	)
	const toggleSidebar = useCallback(() => {
		if (window.matchMedia('(max-width: 767px)').matches) setSideOpen((value) => !value)
		else
			setSideCollapsed((value) => {
				localStorage.setItem('namzu.sidebar-collapsed', String(!value))
				return !value
			})
	}, [])
	const previousCollapsed = useRef(sideCollapsed)
	useEffect(() => {
		if (previousCollapsed.current === sideCollapsed) return
		previousCollapsed.current = sideCollapsed
		if (window.matchMedia('(max-width: 767px)').matches) return
		const control = document.querySelector<HTMLButtonElement>('button[aria-label="Toggle sidebar"]')
		control?.focus({ preventScroll: true })
	}, [sideCollapsed])
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
			if (commandOpen) return
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && !event.altKey) {
				event.preventDefault()
				toggleSidebar()
			}
		}
		window.addEventListener('keydown', key)
		return () => window.removeEventListener('keydown', key)
	}, [toggleSidebar, commandOpen])
	const [appearance, setAppearance] = useState<Appearance>(() => {
		const saved = localStorage.getItem('namzu.appearance')
		return saved === 'light' || saved === 'system' ? saved : 'dark'
	})
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
	const [railSection, setRailSection] = useState<'projects' | 'conversations' | null>(null)
	const railOwner = useRef({ projectId, sessionId })
	useEffect(() => {
		if (railOwner.current.projectId !== projectId || railOwner.current.sessionId !== sessionId) {
			railOwner.current = { projectId, sessionId }
			setRailSection(null)
		}
	}, [projectId, sessionId])
	const [jobsOpen, setJobsOpen] = useState(false)
	const [panelTab, setPanelTab] = useState<'jobs' | 'changes'>('jobs')
	const jobsTrigger = useRef<HTMLButtonElement>(null)
	const changesTrigger = useRef<HTMLButtonElement>(null)
	const closeDetails = useCallback(() => {
		setJobsOpen(false)
		const trigger = panelTab === 'jobs' ? jobsTrigger.current : changesTrigger.current
		trigger?.focus({ preventScroll: true })
	}, [panelTab])
	const [jobs, setJobs] = useState<JobView[]>([])
	const [jobsSessionId, setJobsSessionId] = useState('')
	const [jobOutput, setJobOutput] = useState('')
	const [jobsError, setJobsError] = useState('')
	const [jobsLoading, setJobsLoading] = useState(false)
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)
	const [sending, setSending] = useState<Record<string, boolean>>({})
	const sendingRef = useRef(new Set<string>())
	const input = useRef<HTMLTextAreaElement>(null)
	const transcript = useRef<HTMLDivElement>(null)
	const follow = useRef(true)
	const project = projects.find((item) => item.id === projectId)
	const conversation = conversations.find((item) => item.id === sessionId)
	const thread = threads[sessionId] ?? emptyThread()
	const visibleJobs = jobsSessionId === sessionId ? jobs : []
	const changes = Object.values(thread.tools).filter(
		(tool) => tool.status === 'completed' && tool.view.kind === 'diff',
	).length
	const contextProps = project
		? {
				project,
				changes,
				runningShells:
					jobsSessionId !== sessionId || jobsLoading || jobsError
						? null
						: visibleJobs.filter((job) => job.status === 'running').length,
				jobsUnavailable: jobsSessionId === sessionId && Boolean(jobsError),
				activeTools: thread.activeToolIds.length,
				awaitingApproval: thread.permissions.length > 0,
				running: thread.running,
				onChanges: () => {
					setPanelTab('changes')
					setJobsOpen(true)
				},
				onJobs: () => {
					setPanelTab('jobs')
					setJobsOpen(true)
				},
			}
		: null
	const providerReady = providerProjectId === projectId
	const activeProviders: ProviderView = providerReady
		? providers
		: { available: [], selected: null }
	const draftOwner = sessionId || `project:${projectId}`
	const draft = drafts[draftOwner] ?? ''
	const attached = useAttachments(draftOwner, Boolean(project), (failure) =>
		setError(errorText(failure)),
	)
	const savedSettings = useDraftSettings(draftOwner, Boolean(project), (failure) =>
		setError(errorText(failure)),
	)
	const settings = savedSettings.value.options ?? { permissionMode: 'prompt' as const }
	const defaultProvider = activeProviders.selected?.id ?? activeProviders.available[0]?.id ?? ''
	const choice = savedSettings.value.choice ?? {
		provider: defaultProvider,
		model:
			activeProviders.selected?.model ||
			activeProviders.available.find((provider) => provider.id === defaultProvider)?.defaultModel ||
			'',
	}
	const modelId =
		choice.model ||
		activeProviders.available.find((provider) => provider.id === choice.provider)?.defaultModel ||
		''
	const modelSettingsKey = JSON.stringify([projectId, sessionId, choice.provider, modelId])
	const capabilities = modelSettings?.key === modelSettingsKey ? modelSettings.value : null
	const pluginsKey = modelSettingsKey
	const loadPlugins = async () => {
		const targetProject = projectId
		const targetSession = sessionId
		const key = pluginsKey
		setPluginStates((all) => ({ ...all, [key]: { ...all[key], loading: true } }))
		try {
			const value = await api.plugins(targetProject, targetSession || undefined)
			setPluginStates((all) => ({ ...all, [key]: { loading: false, value } }))
		} catch {
			setPluginStates((all) => ({
				...all,
				[key]: {
					loading: false,
					value: {
						plugins: [],
						live: false,
						canChange: false,
						notice: 'Plugins could not be loaded. Close this menu and try again.',
					},
				},
			}))
		}
	}
	useEffect(() => {
		if (!projectId || !providerReady || !choice.provider || !modelId) return
		let current = true
		void api
			.modelSettings(projectId, choice.provider, modelId, sessionId || undefined)
			.then((value) => {
				if (current) setModelSettings({ key: modelSettingsKey, value })
			})
			.catch(() => {
				if (current)
					setModelSettings({
						key: modelSettingsKey,
						value: {
							notice:
								'Model settings could not be loaded. Try selecting the model again, or reset your effort choice.',
						},
					})
			})
		return () => {
			current = false
		}
	}, [projectId, sessionId, providerReady, choice.provider, modelId, modelSettingsKey])
	const updateProject = useCallback(
		(item: ProjectView) =>
			setProjects((items) => [...items.filter((row) => row.id !== item.id), item]),
		[],
	)
	const act = useCallback(async (action: () => Promise<unknown>) => {
		setError('')
		try {
			await action()
		} catch (failure) {
			setError(errorText(failure))
		}
	}, [])
	useEffect(() => {
		if (!api) {
			setError('Open Namzu using the desktop application.')
			return
		}
		void api
			.projects()
			.then((items) => {
				setProjects(items)
				if (items[0]) setProjectId(items[0].id)
			})
			.catch((failure) => setError(errorText(failure)))
		return api.onEvent((event: DesktopEvent) => {
			if (event.kind === 'connection') {
				updateProject(event.project)
				return
			}
			const id = event.kind === 'permission' ? event.request.sessionId : event.sessionId
			const read = snapshotRead.current
			if (read?.sessionId === id && read.generation === navigation.current && !read.overflow) {
				read.characters += JSON.stringify(event).length
				if (read.characters > 8 * 1024 * 1024 || read.events.length >= 10_000) {
					read.overflow = true
					read.events.length = 0
				} else read.events.push(event)
			}
			setThreads((all) => ({
				...all,
				[id]: applyEvent(all[id] ?? emptyThread(), event),
			}))
			if (event.kind === 'state' && !event.running)
				void attached.reload(event.sessionId).catch((failure) => setError(errorText(failure)))
			if (event.kind === 'prompt')
				setConversations((all) =>
					all.map((item) =>
						item.id === id && item.title === 'New conversation'
							? {
									...item,
									title: (
										event.prompt.trim() ||
										event.attachments?.map((file) => file.name).join(', ') ||
										'New conversation'
									).slice(0, 80),
								}
							: item,
					),
				)
		})
	}, [updateProject, attached.reload])
	useEffect(() => {
		if (!project || project.status === 'connecting' || !project.trusted) return
		let current = true
		void Promise.all([api.conversations(project.id), api.providers(project.id)])
			.then(([rows, available]) => {
				if (!current) return
				setConversations((all) => {
					const returned = new Set(rows.map((row) => row.id))
					return [
						...all.filter((item) => item.projectId !== project.id || !returned.has(item.id)),
						...rows,
					]
				})
				setProviders(available)
				setProviderProjectId(project.id)
			})
			.catch((failure) => {
				if (current) setError(errorText(failure))
			})
		return () => {
			current = false
		}
	}, [project])
	useEffect(() => {
		if (!projectId || !api) return
		let current = true
		const owner = `project:${projectId}`
		void api
			.draft(owner)
			.then((saved) => {
				if (!current || draftsRef.current[owner] !== undefined) return
				draftsRef.current[owner] = saved
				setDrafts((all) => ({ ...all, [owner]: all[owner] ?? saved }))
			})
			.catch((failure) => {
				if (current) setError(errorText(failure))
			})
		return () => {
			current = false
		}
	}, [projectId])
	useEffect(() => {
		if (!sessionId || !api) {
			setJobs([])
			return
		}
		let current = true
		let pending = false
		setJobs([])
		setJobsSessionId(sessionId)
		setJobOutput('')
		setJobsLoading(true)
		setJobsError('')
		const read = async () => {
			if (pending) return
			pending = true
			try {
				const rows = await api.jobs(sessionId)
				if (current) {
					setJobs(rows)
					setJobsSessionId(sessionId)
					setJobsError('')
				}
			} catch (failure) {
				if (current) setJobsError(errorText(failure))
			} finally {
				pending = false
				if (current) setJobsLoading(false)
			}
		}
		void read()
		const timer = setInterval(() => void read(), 2000)
		return () => {
			current = false
			clearInterval(timer)
		}
	}, [sessionId])
	useEffect(() => {
		const node = transcript.current
		if (!node || !sessionId) return
		const observer = new ResizeObserver(() => {
			if (follow.current) node.scrollTop = node.scrollHeight
		})
		observer.observe(node)
		if (node.firstElementChild) observer.observe(node.firstElementChild)
		return () => observer.disconnect()
	}, [sessionId])
	const newConversation = useCallback(async () => {
		if (!projectId) return
		navigation.current += 1
		setSessionId('')
		setSideOpen(false)
		setJobsOpen(false)
		input.current?.focus()
	}, [projectId])

	const openProject = useCallback(async () => {
		const generation = ++navigation.current
		setLoading(true)
		try {
			const item = await api.openProject()
			if (item) {
				updateProject(item)
				if (generation !== navigation.current) return
				setProjectId(item.id)
				setSessionId('')
				setSideOpen(false)
				input.current?.focus()
			}
		} catch (failure) {
			if (generation === navigation.current) throw failure
		} finally {
			setLoading(false)
		}
	}, [updateProject])
	const openConversation = async (view: ConversationView) => {
		const generation = ++navigation.current
		if (snapshotRead.current) snapshotRead.current.events.length = 0
		const read = {
			generation,
			sessionId: view.id,
			events: [] as DesktopEvent[],
			characters: 0,
			overflow: false,
		}
		snapshotRead.current = read
		try {
			const history = await api.openConversation(view.projectId, view.id)
			if (generation !== navigation.current) return
			if (read.overflow)
				throw new Error(
					'This conversation changed while opening. Open it again for its latest history.',
				)
			const replay = [...read.events]
			if (snapshotRead.current === read) snapshotRead.current = null
			setThreads((all) => {
				let restored: ThreadState = {
					...emptyThread(),
					...history.thread,
					messages: history.messages,
					partial: history.partial,
				}
				if (!history.thread) restored = restoreMessages(restored, history.messages)
				for (const event of replay) restored = applyEvent(restored, event)
				return (all[view.id]?.revision ?? 0) > restored.revision
					? all
					: { ...all, [view.id]: restored }
			})
			const [status, savedDraft] = await Promise.all([
				api.providers(view.projectId, view.id),
				api.draft(view.id),
			])
			if (draftsRef.current[view.id] === undefined) {
				draftsRef.current[view.id] = savedDraft
				setDrafts((all) => ({ ...all, [view.id]: all[view.id] ?? savedDraft }))
			}
			if (generation !== navigation.current) return
			setProviders(status)
			setProviderProjectId(view.projectId)
			setSessionId(view.id)
			setProjectId(view.projectId)
			setSideOpen(false)
			follow.current = true
			input.current?.focus()
		} catch (failure) {
			if (generation === navigation.current) throw failure
		} finally {
			if (snapshotRead.current === read) snapshotRead.current = null
		}
	}
	const navigateHistory = async (direction: -1 | 1) => {
		if (historyBusy.current) return
		const index = navigationHistory.index + direction
		const destination = navigationHistory.entries[index]
		if (!destination) return
		historyBusy.current = true
		setHistoryLoading(true)
		const key = `${destination.projectId}/${destination.sessionId}`
		historyReplay.current = key
		const generation = navigation.current + 1
		try {
			if (destination.sessionId) {
				const view = conversations.find(
					(item) => item.id === destination.sessionId && item.projectId === destination.projectId,
				)
				if (!view) throw new Error('This conversation is no longer available.')
				await openConversation(view)
			} else {
				navigation.current += 1
				setProjectId(destination.projectId)
				setSessionId('')
				setSideOpen(false)
			}
			if (generation === navigation.current) {
				setNavigationHistory((previous) => ({ ...previous, index }))
				setJobsOpen(false)
			}
		} catch (failure) {
			if (historyReplay.current === key) historyReplay.current = null
			throw failure
		} finally {
			if (generation !== navigation.current) historyReplay.current = null
			historyBusy.current = false
			setHistoryLoading(false)
		}
	}
	const revealSidebar = (selector: string) => {
		setSideOpen(window.matchMedia('(max-width: 767px)').matches)
		setSideCollapsed(false)
		localStorage.setItem('namzu.sidebar-collapsed', 'false')
		requestAnimationFrame(() =>
			document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }),
		)
	}
	const changeDraft = (target: string, value: string) => {
		if (editingQueue.current.has(target)) return
		draftsRef.current[target] = value
		setDrafts((all) => ({ ...all, [target]: value }))
		void api.saveDraft(target, value).catch((failure) => setError(errorText(failure)))
	}
	const editQueued = useCallback(
		async (itemId?: string) => {
			const target = sessionId
			if (!target || editingQueue.current.has(target)) return
			if ((draftsRef.current[target] ?? '').length > 0)
				throw new Error('Send or clear your current draft before editing a queued message.')
			editingQueue.current.add(target)
			setQueueEditing((all) => ({ ...all, [target]: true }))
			try {
				const items = threadsRef.current[target]?.queuedItems ?? []
				const item = itemId ? items.find((item) => item.id === itemId) : items.at(-1)
				const message = await api.takeQueued(target, itemId)
				if (message !== null) {
					draftsRef.current[target] = message
					setDrafts((all) => ({ ...all, [target]: message }))
					await attached.reload(target)
					if (item)
						await savedSettings.save(target, {
							...savedSettings.get(target),
							options: { effort: item.effort, permissionMode: item.permissionMode ?? 'prompt' },
						})
				}
			} finally {
				editingQueue.current.delete(target)
				setQueueEditing((all) => ({ ...all, [target]: false }))
				if (activeSession.current === target) input.current?.focus()
			}
		},
		[sessionId, attached.reload, savedSettings.get, savedSettings.save],
	)
	const send = async () => {
		if (
			(!draft.trim() && attached.get(draftOwner).length === 0) ||
			!project?.trusted ||
			project.status !== 'ready' ||
			!choice.provider ||
			!providerReady ||
			savedSettings.loading ||
			sendingRef.current.has(draftOwner) ||
			attached.isBusy(draftOwner)
		)
			return
		const owner = draftOwner
		const prompt = draft
		const attachmentIds = attached.get(owner).map((file) => file.id)
		const options = { ...settings, attachmentIds }
		const originalSettings = savedSettings.get(owner)
		const route = { ...choice }
		const generation = navigation.current
		let target = sessionId
		sendingRef.current.add(owner)
		setSending((all) => ({ ...all, [owner]: true }))
		try {
			if (!target) {
				const view = await api.newConversation(project.id)
				target = view.id
				setConversations((all) => [view, ...all])
				setThreads((all) => ({ ...all, [view.id]: emptyThread() }))
				// The created conversation owns retries, even if route selection fails.
				// Move typing that arrived during creation rather than replacing it.
				const latest =
					generation === navigation.current ? (draftsRef.current[owner] ?? prompt) : prompt
				draftsRef.current[target] = latest
				setDrafts((all) => ({ ...all, [target]: latest }))
				const promotedSettings = savedSettings.save(target, { choice: route, options: settings })
				sendingRef.current.add(target)
				setSending((all) => ({ ...all, [target]: true }))
				const draftWrites: Promise<void>[] = []
				if (generation === navigation.current) {
					draftWrites.push(api.saveDraft(owner, ''))
					draftsRef.current[owner] = ''
					setDrafts((all) => ({ ...all, [owner]: '' }))
					setSessionId(target)
					setSideOpen(false)
				}
				// Admit both saves before yielding to newer typing in the promoted editor.
				draftWrites.push(api.saveDraft(target, latest))
				await Promise.all(draftWrites)
				await attached.promote(owner, target)
				await promotedSettings
				if (savedSettings.get(owner) === originalSettings) await savedSettings.save(owner, {})
			}
			// Preserve the actual route even when it came from a provider default.
			await savedSettings.save(target, { choice: route, options: settings })
			if (!thread.running) await api.selectProvider(target, route.provider, route.model)
			await api.send(target, prompt, options)
			attached.consume(target, attachmentIds)
			// A fast failure may settle before this admission reply arrives. Read main's
			// draft after consumption as well as on settlement, so retry files stay visible.
			void attached.reload(target).catch((failure) => setError(errorText(failure)))
			if (draftsRef.current[target] === prompt) {
				draftsRef.current[target] = ''
				setDrafts((all) => ({ ...all, [target]: '' }))
			}
			if (activeSession.current === target) follow.current = true
		} finally {
			sendingRef.current.delete(owner)
			sendingRef.current.delete(target)
			setSending((all) => ({ ...all, [owner]: false, [target]: false }))
		}
	}

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.isComposing || event.keyCode === 229) return
			if (event.defaultPrevented) return
			if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
				event.preventDefault()
				if (commandOpen) setCommandOpen(false)
				else openCommands()
				return
			}
			// Modal dismissal must never become a cancellation of the underlying turn.
			if (commandOpen) return
			if (event.key === 'Escape') {
				if (sideOpen || jobsOpen) {
					setSideOpen(false)
					if (jobsOpen) closeDetails()
				} else if (thread.running) void act(() => api.cancel(sessionId))
				return
			}
			if (
				(event.metaKey || event.ctrlKey) &&
				!event.altKey &&
				!event.shiftKey &&
				event.key.toLowerCase() === 'o'
			) {
				event.preventDefault()
				if (!loading) void act(openProject)
			}
			if (
				(event.metaKey || event.ctrlKey) &&
				!event.altKey &&
				!event.shiftKey &&
				event.key.toLowerCase() === 'n'
			) {
				event.preventDefault()
				if (!loading && project?.trusted && project.status === 'ready') void act(newConversation)
			}
			if (event.altKey && event.key === 'ArrowUp' && sessionId) {
				event.preventDefault()
				void act(() => editQueued())
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [
		sideOpen,
		jobsOpen,
		sessionId,
		thread.running,
		act,
		newConversation,
		openProject,
		editQueued,
		commandOpen,
		openCommands,
		loading,
		project?.trusted,
		project?.status,
		closeDetails,
	])
	const shortcutModifier = /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'
	const commandItems: CommandPaletteItem[] = [
		...conversations
			.filter((view) => projects.some((item) => item.id === view.projectId))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map((view) => {
				const owner = projects.find((item) => item.id === view.projectId)
				return {
					id: `conversation:${view.id}`,
					label: view.title,
					group: 'Chats',
					meta: owner?.name,
					keywords: [owner?.name ?? '', view.id],
					disabled: !owner?.trusted || owner.status !== 'ready',
					onAction: () => void act(() => openConversation(view)),
				}
			}),
		{
			id: 'new-conversation',
			label: 'New conversation',
			group: 'Quick actions',
			icon: <SquarePenIcon aria-hidden="true" />,
			shortcut: [shortcutModifier, 'N'],
			disabled: loading || !project?.trusted || project.status !== 'ready',
			onAction: () => void act(newConversation),
		},
		{
			id: 'open-project',
			label: 'Open folder',
			group: 'Quick actions',
			icon: <FolderIcon aria-hidden="true" />,
			shortcut: [shortcutModifier, 'O'],
			disabled: loading,
			onAction: () => void act(openProject),
		},
		...projects.map((item) => ({
			id: `project:${item.id}`,
			label: item.name,
			group: 'Projects',
			icon: <FolderIcon aria-hidden="true" />,
			keywords: [item.path],
			onAction: () => {
				navigation.current += 1
				setProjectId(item.id)
				setSessionId('')
				setSideOpen(false)
				setJobsOpen(false)
				input.current?.focus()
			},
		})),
	]
	return (
		<div className="app" data-sidebar-collapsed={sideCollapsed}>
			<CommandPalette
				open={commandOpen}
				onOpenChange={setCommandOpen}
				triggerRef={commandTrigger}
				items={commandItems}
				loading={commandListing.loading}
				notice={commandListing.notice}
				onRetry={refreshCommands}
			/>
			<WindowTitlebar
				appearance={appearance}
				onBack={() => void act(() => navigateHistory(-1))}
				onForward={() => void act(() => navigateHistory(1))}
				canGoBack={!historyLoading && navigationHistory.index > 0}
				canGoForward={
					!historyLoading && navigationHistory.index < navigationHistory.entries.length - 1
				}
				onToggleSidebar={toggleSidebar}
				sidebarExpanded={mobile ? sideOpen : !sideCollapsed}
				onOpenProject={() => void act(openProject)}
				onNewConversation={() => void act(newConversation)}
				newConversationDisabled={loading || !project?.trusted || project.status !== 'ready'}
				onError={setError}
			/>
			<NavigationRail
				section={railSection ?? (sessionId ? 'conversations' : 'home')}
				appearance={appearance}
				onHome={() => {
					navigation.current += 1
					setSessionId('')
					setRailSection(null)
					setJobsOpen(false)
					setSideOpen(false)
				}}
				onProjects={() => {
					setRailSection('projects')
					revealSidebar('[data-project-group] .project-row')
				}}
				onConversations={() => {
					setRailSection('conversations')
					openCommands()
				}}
				onAppearance={() =>
					setAppearance((value) =>
						value === 'system' ? 'dark' : value === 'dark' ? 'light' : 'system',
					)
				}
			/>
			<Sidebar
				projects={projects}
				conversations={conversations}
				projectId={projectId}
				sessionId={sessionId}
				threads={threads}
				open={sideOpen}
				collapsed={sideCollapsed}
				opening={loading}
				onClose={() => setSideOpen(false)}
				onOpenProject={() => void act(openProject)}
				onNewConversation={() => void act(newConversation)}
				onSearch={openCommands}
				onProject={(id) => {
					navigation.current += 1
					setProjectId(id)
					setSessionId('')
				}}
				onConversation={(view) => void act(() => openConversation(view))}
			/>
			<main className={`workspace ${jobsOpen ? 'jobs-open' : ''}`}>
				<WorkspacePageHeader className="topbar">
					<WorkspaceBreadcrumb ariaLabel="Conversation breadcrumb" className="breadcrumb flex-1">
						<WorkspaceBreadcrumbItem className="breadcrumb-project shrink">
							<WorkspaceBreadcrumbText className="max-w-40" data-project-label>
								{project?.name ?? 'Workspace'}
							</WorkspaceBreadcrumbText>
						</WorkspaceBreadcrumbItem>
						<WorkspaceBreadcrumbSeparator className="breadcrumb-separator">
							<WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
						</WorkspaceBreadcrumbSeparator>
						<WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
							<h2 className="min-w-0 flex-1">
								<WorkspaceBreadcrumbText data-conversation-title>
									{conversation?.title ?? 'Start a conversation'}
								</WorkspaceBreadcrumbText>
							</h2>
						</WorkspaceBreadcrumbItem>
					</WorkspaceBreadcrumb>
					<Button
						ref={jobsTrigger}
						type="button"
						variant="ghost-muted"
						size="sm"
						className="jobs-button"
						aria-label="Background work"
						aria-description={
							jobsSessionId !== sessionId || jobsLoading || jobsError
								? 'Background work has not been confirmed'
								: `${visibleJobs.filter((job) => job.status === 'running').length} running shells in this conversation`
						}
						onClick={() => {
							setPanelTab('jobs')
							setJobsOpen(panelTab !== 'jobs' || !jobsOpen)
						}}
						disabled={!sessionId}
					>
						<TerminalIcon aria-hidden="true" className="size-4" />
						<span className="jobs-button-label">Background work</span>
						{visibleJobs.some((job) => job.status === 'running') && (
							<span>{visibleJobs.filter((job) => job.status === 'running').length}</span>
						)}
					</Button>
					<Button
						ref={changesTrigger}
						type="button"
						variant="ghost-muted"
						size="icon-sm"
						aria-label="Show changes"
						disabled={!sessionId}
						aria-pressed={jobsOpen && panelTab === 'changes'}
						onClick={() => {
							setPanelTab('changes')
							setJobsOpen(panelTab !== 'changes' || !jobsOpen)
						}}
					>
						<FileDiffIcon className="size-4" />
					</Button>
					{contextProps && thread.messages.length > 0 && <ProjectContextMenu {...contextProps} />}
				</WorkspacePageHeader>
				{(error || project?.error) && (
					<div className="connection-error">
						<ChatErrorBanner
							message={error || project?.error || ''}
							onRetry={
								project?.status === 'error'
									? () =>
											void act(async () => updateProject(await api.reconnectProject(project.id)))
									: undefined
							}
							onDismiss={project?.status !== 'error' ? () => setError('') : undefined}
						/>
					</div>
				)}
				{!project ? (
					<Empty className="welcome">
						<Wordmark hero />

						<EmptyHeader className="max-w-lg px-8">
							<EmptyTitle>
								<h1>What would you like to work on?</h1>
							</EmptyTitle>
							<EmptyDescription>
								Open a project to pick up where you left off,
								<br />
								or start a new conversation.
							</EmptyDescription>
						</EmptyHeader>
						<Button
							type="button"
							className="primary"
							size="default"
							onClick={() => void act(openProject)}
							disabled={loading}
						>
							<Icon name="folder" />
							Open a project
						</Button>
					</Empty>
				) : !project.trusted ? (
					<Empty className="welcome">
						<EmptyHeader className="max-w-lg px-8">
							<EmptyTitle>
								<h1>Make this your workspace</h1>
							</EmptyTitle>
							<EmptyDescription className="project-path">{project.path}</EmptyDescription>
							<EmptyDescription>
								Namzu will work with the files in this folder.
								<br />
								Review the folder before allowing access.
							</EmptyDescription>
						</EmptyHeader>
						<Button
							type="button"
							className="primary"
							size="default"
							disabled={project.status !== 'ready'}
							onClick={() =>
								void act(async () => updateProject(await api.trustProject(project.id)))
							}
						>
							Review folder access
						</Button>
					</Empty>
				) : (
					<div
						className="chat-stage"
						data-empty={thread.messages.length === 0}
						data-context-card={!jobsOpen && thread.messages.length > 0}
					>
						{contextProps && thread.messages.length > 0 && !jobsOpen && (
							<ProjectContextCard {...contextProps} />
						)}
						<div
							className="transcript"
							ref={transcript}
							onScroll={() => {
								if (transcript.current)
									follow.current =
										transcript.current.scrollHeight -
											transcript.current.scrollTop -
											transcript.current.clientHeight <
										100
							}}
						>
							<div className="conversation-body">
								{thread.partial && (
									<p className="notice">
										Showing the latest part of this conversation. The full record remains on this
										device.
									</p>
								)}
								{thread.timeline.map((entry) => {
									if (entry.kind === 'tool') {
										const tool = thread.tools[entry.id]
										return tool ? (
											<div
												className="tool-list"
												key={`tool-${entry.id}`}
												data-timeline-turn={entry.turn}
											>
												<ToolRow tool={tool} active={thread.activeToolIds.includes(entry.id)} />
											</div>
										) : null
									}
									const message = thread.messages[entry.index]
									return message ? (
										<Message
											from={message.role}
											className={`message ${message.role}`}
											key={`message-${entry.index}`}
											data-timeline-turn={entry.turn}
										>
											<MessageContent text={message.text} markdown={message.role === 'assistant'} />
											{message.attachments && (
												<div className="mt-2">
													<AttachmentList attachments={message.attachments} />
												</div>
											)}
										</Message>
									) : null
								})}
								{thread.reasoning && (
									<details className="reasoning">
										<summary>Thinking</summary>
										<p>{thread.reasoning}</p>
									</details>
								)}
								<ChangedFilesCard
									tools={thread.tools}
									onOpen={() => {
										setPanelTab('changes')
										setJobsOpen(true)
									}}
								/>
								{thread.error && (
									<p className="inline-error" role="alert">
										{thread.error}
									</p>
								)}
								{thread.running && (
									<div className="working">
										<span className="activity" />
										{thread.permissions.length ? 'Waiting for your decision' : 'Working'}
									</div>
								)}
								{!thread.running && thread.stopReason && thread.stopReason !== 'end_turn' && (
									<p className="notice">
										{thread.stopReason === 'cancelled'
											? 'Stopped. You can continue from here.'
											: thread.stopReason === 'max_turns'
												? 'Turn limit reached. Review the work before continuing.'
												: thread.stopReason === 'refused'
													? 'The action was not approved.'
													: 'This turn could not finish.'}
									</p>
								)}
							</div>
						</div>
						<Composer
							inputRef={input}
							permissions={thread.permissions}
							onApproval={(permission, approved) =>
								void act(() => api.approve(permission.sessionId, permission.id, approved))
							}
							projectName={project.name}
							projectId={project.id}
							sessionId={sessionId || undefined}
							projectPath={project.path}
							onOpenProject={() => void act(openProject)}
							empty={thread.messages.length === 0}
							draft={draft}
							onDraftChange={(value) => changeDraft(draftOwner, value)}
							providers={activeProviders}
							connected={
								project.status === 'ready' &&
								providerReady &&
								project.trusted &&
								!savedSettings.loading
							}
							providersLoading={!providerReady}
							choice={choice}
							onChoiceChange={(value) => {
								void act(() =>
									savedSettings.save(draftOwner, {
										choice: value,
										options: { ...settings, effort: undefined },
									}),
								)
							}}
							attachments={attached.files}
							attachmentsBusy={attached.busy}
							onAttach={() => void act(attached.pick)}
							onAddFiles={(files) => void act(() => attached.add(files))}
							onRemoveAttachment={(id) => void act(() => attached.remove(id))}
							settings={settings}
							capabilities={capabilities}
							onSettingsChange={(value) =>
								void act(() => savedSettings.save(draftOwner, { choice, options: value }))
							}
							plugins={pluginStates[pluginsKey]?.value}
							pluginsLoading={pluginStates[pluginsKey]?.loading ?? false}
							onOpenPlugins={() => void loadPlugins()}
							onSetPluginEnabled={async (plugin, enabled) => {
								if (!sessionId)
									throw new Error('Send a message before changing conversation plugins.')
								const key = pluginsKey
								const value = await api.setPluginEnabled(sessionId, plugin.name, enabled)
								setPluginStates((all) => ({ ...all, [key]: { loading: false, value } }))
							}}
							running={thread.running}
							sending={sending[draftOwner] ?? false}
							queued={thread.queued}
							queuedItems={thread.queuedItems}
							editingQueued={queueEditing[sessionId] ?? false}
							onSend={() => void act(send)}
							onStop={() => void act(() => api.cancel(sessionId))}
							onEditQueued={(itemId) => void act(() => editQueued(itemId))}
							onRemoveQueued={(itemId) => void act(() => api.removeQueued(sessionId, itemId))}
						/>
					</div>
				)}
				<aside
					className="jobs-panel"
					data-open={jobsOpen}
					inert={!jobsOpen}
					aria-hidden={!jobsOpen}
					aria-label={panelTab === 'jobs' ? 'Background work' : 'Changes'}
				>
					<div className="section-heading">
						<div className="flex items-center gap-1">
							<Button
								size="xs"
								variant="ghost-muted"
								aria-pressed={panelTab === 'changes'}
								onClick={() => setPanelTab('changes')}
							>
								<FileDiffIcon className="size-3.5" />
								Changes
							</Button>
							<Button
								size="xs"
								variant="ghost-muted"
								aria-pressed={panelTab === 'jobs'}
								onClick={() => setPanelTab('jobs')}
							>
								<TerminalIcon className="size-3.5" />
								Background work
							</Button>
						</div>
						<Button
							type="button"
							variant="ghost-muted"
							size="icon-sm"
							className="icon-button"
							aria-label={panelTab === 'jobs' ? 'Close background work' : 'Close changes'}
							onClick={closeDetails}
						>
							<Icon name="close" />
						</Button>
					</div>
					{panelTab === 'changes' ? (
						<ChangesPanel
							tools={thread.tools}
							dark={
								appearance === 'dark' ||
								(appearance === 'system' &&
									window.matchMedia('(prefers-color-scheme: dark)').matches)
							}
						/>
					) : (
						<div className="panel-scroll">
							{jobsError ? (
								<p role="alert" className="jobs-error">
									{jobsError}
								</p>
							) : jobsLoading ? (
								<p className="quiet">Loading background work…</p>
							) : visibleJobs.length === 0 ? (
								<p className="quiet">No background shells in this conversation.</p>
							) : (
								visibleJobs.map((job) => (
									<div className="job" key={job.id}>
										<strong>{job.status}</strong>
										<code>{job.command}</code>
										<div>
											<Button
												type="button"
												onClick={() =>
													void act(async () => {
														const target = sessionId
														const generation = navigation.current
														try {
															const output = await api.readJob(target, job.id)
															if (
																activeSession.current !== target ||
																generation !== navigation.current
															)
																return
															setJobOutput(
																`${output.truncated ? 'Earlier output omitted.\n' : ''}${output.output}`,
															)
														} catch (failure) {
															if (
																activeSession.current === target &&
																generation === navigation.current
															)
																throw failure
														}
													})
												}
											>
												View output
											</Button>
											{job.status === 'running' && (
												<Button
													type="button"
													onClick={() => void act(() => api.stopJob(sessionId, job.id))}
												>
													Stop
												</Button>
											)}
										</div>
									</div>
								))
							)}
							{jobOutput && <pre className="job-output">{jobOutput}</pre>}
						</div>
					)}
				</aside>
			</main>
		</div>
	)
}
createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<TooltipProvider delay={250}>
			<App />
		</TooltipProvider>
	</React.StrictMode>,
)
