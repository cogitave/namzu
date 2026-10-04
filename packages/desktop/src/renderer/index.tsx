import { MessageSquare, Minus } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
	type ThreadState,
	applyEvent,
	emptyThread,
	restoreMessages,
	threadPhase,
} from '../shared/projection.js'
import type {
	ComposerModelSettings,
	PalComputerView as ComputerState,
	ConversationView,
	DesktopEvent,
	HumanComputerView,
	JobView,
	PalComputerInput,
	PalComputerStreamView,
	PalInput,
	PalScreenView,
	PalView,
	ProjectView,
	ProviderView,
} from '../shared/protocol.js'
import { ChangedFilesCard } from './changed-files-card.js'
import { ChangesPanel } from './changes-panel.js'
import { ChatErrorBanner } from './chat-error-banner.js'
import { CommandPalette, type CommandPaletteItem } from './command-palette.js'
import {
	type ComposerPlugin,
	type ComposerPluginInventory,
	type ComposerPublicPlugin,
	type PluginCollection,
	type PluginSelection,
	pluginRowId,
} from './composer-plugins.js'
import { Composer } from './composer.js'
import { type ComputerChatLayout, useComputerChatMotion } from './computer-chat-motion.js'
import { ComputerInputRetiredError, computerSurfaceOwnsFocus } from './computer-input-focus.js'
import { ComputerInputQueue, computerInputOwnerMatches } from './computer-input-queue.js'
import { ComputerWorkspaceToolbar } from './computer-workspace-toolbar.js'
import { compareConversationRecency } from './conversation-order.js'
import {
	ArrowUpIcon,
	FileDiffIcon,
	FolderIcon,
	PanelLeftIcon,
	PlusIcon,
	SquareIcon,
	SquarePenIcon,
	TerminalIcon,
	XIcon,
} from './icons.js'
import { JobRow } from './job-row.js'
import { resolveComposerModelChoice } from './model-choice.js'
import { NavigationRail } from './navigation-rail.js'
import { normalConversationProject } from './normal-conversation.js'
import { PalComputerView } from './pal-computer-view.js'
import { PalContextCard, type PalContextProps } from './pal-context.js'
import { PalCustomizeDialog, PalSidebarSection, PalWelcome, PalsPage } from './pals-page.js'
import { PluginsPage, PluginsSidebar } from './plugins-page.js'
import { ProjectContextCard, ProjectContextMenu } from './project-context.js'
import { type Appearance, type ConversationCollection, Sidebar } from './sidebar.js'
import { Transcript } from './transcript.js'
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
function App() {
	const [pals, setPals] = useState<PalView[]>([])
	const [palsLoading, setPalsLoading] = useState(true)
	const [palsError, setPalsError] = useState('')
	const [palsSaving, setPalsSaving] = useState(false)
	const [palsPage, setPalsPage] = useState(false)
	const [creatingPal, setCreatingPal] = useState(false)
	const [editingPal, setEditingPal] = useState<PalView>()
	const [draftPalModel, setDraftPalModel] = useState<PalView['model']>(null)
	const [palComputers, setPalComputers] = useState<Record<string, ComputerState>>({})
	// A computer tab stays open when its owning chat is selected. Selection is
	// view state only: it never opens another conversation or changes its draft.
	const [palScreen, setPalScreen] = useState<{
		palId: string
		activeTab: 'chat' | 'computer'
	}>()
	const [palProfileOpen, setPalProfileOpen] = useState(true)
	const [computerProfileOpen, setComputerProfileOpen] = useState(false)
	const [computerChat, setComputerChatState] = useState<ComputerChatLayout>('hidden')
	const [floatingChatMinimized, setFloatingChatMinimizedState] = useState(false)
	const [streamRefresh, setStreamRefresh] = useState(0)
	const [liveStream, setLiveStream] = useState<{
		palId: string
		value?: PalComputerStreamView
		loading?: boolean
		error?: string
	}>()
	const [palScreens, setPalScreens] = useState<
		Record<
			string,
			{
				generation?: string
				screen?: PalScreenView
				loading?: boolean
				error?: string
			}
		>
	>({})
	const [humanComputer, setHumanComputer] = useState<HumanComputerView>()
	const [screenRefresh, setScreenRefresh] = useState(0)
	const [controlBusy, setControlBusy] = useState(false)
	const controlPending = useRef(false)
	const computerReadEpoch = useRef(0)
	const startingComputers = useRef(new Set<string>())
	const captureFlight = useRef<Promise<PalScreenView> | undefined>(undefined)
	const inputSequence = useRef(0)
	const computerInputViewEpoch = useRef(0)
	const computerInputReadyStream = useRef<string | undefined>(undefined)
	const retireComputerPendingInput = useCallback(() => {
		computerInputViewEpoch.current += 1
	}, [])
	const invalidateComputerInput = useCallback(() => {
		retireComputerPendingInput()
		computerInputReadyStream.current = undefined
	}, [retireComputerPendingInput])
	useEffect(() => {
		const focus = () => {
			if (!computerSurfaceOwnsFocus(document.activeElement)) retireComputerPendingInput()
		}
		document.addEventListener('focusin', focus)
		window.addEventListener('blur', retireComputerPendingInput)
		return () => {
			document.removeEventListener('focusin', focus)
			window.removeEventListener('blur', retireComputerPendingInput)
		}
	}, [retireComputerPendingInput])
	const [inputBusy, setInputBusy] = useState(false)
	const previousNormalProject = useRef<string | undefined>(undefined)
	const [projects, setProjects] = useState<ProjectView[]>([])
	const [projectId, setProjectId] = useState('')
	const [conversations, setConversations] = useState<ConversationView[]>([])
	const [sessionId, setSessionId] = useState('')
	const [conversationSelection, setConversationSelection] = useState<{
		sessionId: string
		collection: ConversationCollection
	} | null>(null)
	const conversationCollection =
		conversationSelection?.sessionId === sessionId ? conversationSelection.collection : 'projects'
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
	const [providerOwner, setProviderOwner] = useState('')
	const providerKey = JSON.stringify([projectId, sessionId])
	const providerReadOwner = useRef(providerKey)
	providerReadOwner.current = providerKey
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
	const [commandListing, setCommandListing] = useState({
		loading: false,
		notice: '',
	})
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
	const [railSection, setRailSection] = useState<'spaces' | 'plugins' | null>(null)
	const previousRailSection = useRef(railSection)
	useEffect(() => {
		const previous = previousRailSection.current
		previousRailSection.current = railSection
		if (previous === 'plugins' && railSection === null)
			input.current?.focus({ preventScroll: true })
	}, [railSection])
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
	const pal = pals.find((item) => item.id === project?.palId)
	useEffect(() => {
		if (project?.id && !project?.palId) previousNormalProject.current = project.id
	}, [project?.id, project?.palId])
	// Promoting a new Pal conversation keeps its open views. Explicit session
	// navigation already closes them in openConversation; owner changes do here.
	const routeKey = JSON.stringify([projectId, railSection, palsPage])
	const previousRoute = useRef(routeKey)
	useEffect(() => {
		if (previousRoute.current !== routeKey) {
			previousRoute.current = routeKey
			setPalScreen(undefined)
		}
	}, [routeKey])
	useEffect(() => {
		if (!api.humanComputer) return
		let current = true
		void api.humanComputer().then(
			(value) => {
				if (current) setHumanComputer(value)
			},
			(failure) => {
				if (current) setError(errorText(failure))
			},
		)
		return () => {
			current = false
		}
	}, [])
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
				phase: threadPhase(thread),
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
	const providerReady = providerOwner === providerKey
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
	const settings = savedSettings.value.options ?? {
		permissionMode: 'prompt' as const,
	}
	const choice = resolveComposerModelChoice({
		providers: activeProviders,
		draftChoice: savedSettings.value.choice,
		palModel: pal?.model,
		sessionId,
	})
	const modelId =
		choice.model ||
		activeProviders.available.find((provider) => provider.id === choice.provider)?.defaultModel ||
		''
	const modelSettingsKey = JSON.stringify([projectId, sessionId, choice.provider, modelId])
	const capabilities = modelSettings?.key === modelSettingsKey ? modelSettings.value : null
	const pluginsKey = modelSettingsKey
	const pluginOwner = useRef({ key: pluginsKey, generation: 0 })
	if (pluginOwner.current.key !== pluginsKey) {
		pluginOwner.current.key = pluginsKey
		pluginOwner.current.generation++
	}
	const [pluginCollection, setPluginCollection] = useState<PluginCollection>('public')
	const [pluginSelection, setPluginSelection] = useState<
		PluginSelection & {
			key: string
			generation: number
		}
	>()
	const selectedPlugin =
		pluginSelection?.key === pluginsKey &&
		pluginSelection.generation === pluginOwner.current.generation
			? pluginSelection
			: undefined
	useEffect(() => {
		if (railSection !== 'plugins') setPluginSelection(undefined)
	}, [railSection])
	const openPluginDetails = (
		plugin: ComposerPlugin | ComposerPublicPlugin,
		collection: PluginCollection,
	) => {
		if (!project?.trusted || project.status !== 'ready' || pluginOwner.current.key !== pluginsKey)
			return
		setPluginSelection({
			key: pluginsKey,
			generation: pluginOwner.current.generation,
			collection,
			name: plugin.name,
			scope: 'scope' in plugin ? plugin.scope : undefined,
		})
		setPluginCollection(collection)
		setSideOpen(false)
	}
	const tryPlugin = (plugin: ComposerPlugin) => {
		const view = pluginStates[pluginsKey]?.value
		if (
			!sessionId ||
			!project?.trusted ||
			!palCanWork ||
			project.status !== 'ready' ||
			!view?.live ||
			pluginStates[pluginsKey]?.loading ||
			!view.plugins.some(
				(entry) =>
					entry.name === plugin.name && entry.scope === plugin.scope && entry.status === 'enabled',
			)
		)
			return
		const generation = pluginOwner.current.generation
		setRailSection(null)
		setPalsPage(false)
		setSideOpen(false)
		requestAnimationFrame(() => {
			if (pluginOwner.current.key !== pluginsKey || pluginOwner.current.generation !== generation)
				return
			document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus({ preventScroll: true })
		})
	}
	const returnToPlugins = (focusSearch: boolean) => {
		const selected = selectedPlugin
		const generation = pluginOwner.current.generation
		setPluginSelection(undefined)
		setSideOpen(false)
		requestAnimationFrame(() => {
			if (pluginOwner.current.key !== pluginsKey || pluginOwner.current.generation !== generation)
				return
			const row = !focusSearch && selected ? document.getElementById(pluginRowId(selected)) : null
			;(row ?? document.getElementById('installed-plugin-search'))?.focus({
				preventScroll: true,
			})
		})
	}
	const backToPlugins = () => returnToPlugins(false)
	const searchPlugins = () => returnToPlugins(true)
	const loadPlugins = useCallback(async () => {
		const targetProject = projectId
		const targetSession = sessionId
		const key = pluginsKey
		setPluginStates((all) => ({
			...all,
			[key]: { ...all[key], loading: true },
		}))
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
						notice: 'Plugins could not be loaded. Try again.',
					},
				},
			}))
		}
	}, [projectId, sessionId, pluginsKey])
	const setPluginEnabled = async (
		plugin: ComposerPluginInventory['plugins'][number],
		enabled: boolean,
	) => {
		if (!sessionId) throw new Error('Send a message before changing conversation plugins.')
		const key = pluginsKey
		const value = await api.setPluginEnabled(sessionId, plugin.name, enabled)
		setPluginStates((all) => ({ ...all, [key]: { loading: false, value } }))
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
		let current = true
		void api
			.pals()
			.then((items) => {
				if (current) setPals(items)
			})
			.catch((failure) => {
				if (current) setPalsError(errorText(failure))
			})
			.finally(() => {
				if (current) setPalsLoading(false)
			})
		return () => {
			current = false
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
		void api
			.conversations(project.id)
			.then((rows) => {
				if (!current) return
				setConversations((all) => {
					const returned = new Set(rows.map((row) => row.id))
					return [
						...all.filter((item) => item.projectId !== project.id || !returned.has(item.id)),
						...rows,
					]
				})
			})
			.catch((failure) => {
				if (current) setError(errorText(failure))
			})
		return () => {
			current = false
		}
	}, [project])
	useEffect(() => {
		if (!project || project.status === 'connecting' || !project.trusted) return
		let current = true
		const owner = JSON.stringify([project.id, sessionId])
		void api
			.providers(project.id, sessionId || undefined)
			.then((available) => {
				if (!current || providerReadOwner.current !== owner) return
				setProviders(available)
				setProviderOwner(owner)
			})
			.catch((failure) => {
				if (current && providerReadOwner.current === owner) setError(errorText(failure))
			})
		return () => {
			current = false
		}
	}, [project, sessionId])
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
		const generation = ++navigation.current
		setLoading(true)
		try {
			let destination = normalConversationProject(
				projects,
				projectId,
				previousNormalProject.current,
			)
			if (!destination) {
				if (!api.openChat) throw new Error('Restart the desktop app to open a normal conversation.')
				destination = await api.openChat()
				updateProject(destination)
			}
			if (generation !== navigation.current) return
			if (destination.palId) throw new Error('A normal conversation cannot use a Pal workspace.')
			previousNormalProject.current = destination.id
			setProjectId(destination.id)
			setSessionId('')
			setConversationSelection(null)
			setPalScreen(undefined)
			setRailSection(null)
			setPalsPage(false)
			setSideOpen(false)
			setJobsOpen(false)
			requestAnimationFrame(() => input.current?.focus())
		} finally {
			setLoading(false)
		}
	}, [projects, projectId, updateProject])

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
				setRailSection(null)
				setPalsPage(false)
				setSideOpen(false)
				setJobsOpen(false)
				input.current?.focus()
			}
		} catch (failure) {
			if (generation === navigation.current) throw failure
		} finally {
			setLoading(false)
		}
	}, [updateProject])
	const selectProject = (id: string) => {
		if (!projects.some((item) => item.id === id)) return
		navigation.current += 1
		setProjectId(id)
		setSessionId('')
		setConversationSelection(null)
		setPalScreen(undefined)
		setRailSection(null)
		setPalsPage(false)
		setSideOpen(false)
		setJobsOpen(false)
	}
	const openConversation = async (
		view: ConversationView,
		collection: ConversationCollection = 'projects',
	) => {
		const generation = ++navigation.current
		setPalScreen(undefined)
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
			setProviderOwner(JSON.stringify([view.projectId, view.id]))
			setSessionId(view.id)
			setConversationSelection({ sessionId: view.id, collection })
			setProjectId(view.projectId)
			setRailSection(null)
			setPalsPage(false)
			setSideOpen(false)
			follow.current = true
			input.current?.focus()
		} catch (failure) {
			if (generation === navigation.current) throw failure
		} finally {
			if (snapshotRead.current === read) snapshotRead.current = null
		}
	}
	const upsertPal = (value: PalView) =>
		setPals((all) =>
			all.some((item) => item.id === value.id)
				? all.map((item) => (item.id === value.id ? value : item))
				: [...all, value],
		)
	const showPalOnboarding = () => {
		navigation.current += 1
		if (!palsPage) setDraftPalModel(null)
		setEditingPal(undefined)
		setCreatingPal(false)
		setPalsPage(true)
		setRailSection(null)
		setJobsOpen(false)
		setSideOpen(false)
		setPalsError('')
	}
	const showPalEditor = (value?: PalView) => {
		setEditingPal(value)
		setCreatingPal(!value)
		if (value) setDraftPalModel(value.model)
		setPalsError('')
	}
	const openPal = async (value: PalView) => {
		const generation = ++navigation.current
		setPalScreen(undefined)
		setLoading(true)
		try {
			const opened = await api.openPal(value.id)
			upsertPal(opened.pal)
			updateProject(opened.project)
			setConversations((all) => [
				...all.filter((item) => item.projectId !== opened.project.id),
				...opened.conversations,
			])
			if (generation !== navigation.current) return
			setPalsPage(false)
			setRailSection(null)
			setSideOpen(false)
			setJobsOpen(false)
			setProjectId(opened.project.id)
			setSessionId('')
			const latest = [...opened.conversations].sort(compareConversationRecency)[0]
			if (latest) await openConversation(latest)
		} finally {
			setLoading(false)
		}
	}
	const savePal = async (value: PalInput, id?: string) => {
		setPalsSaving(true)
		setPalsError('')
		try {
			const editing = editingPal
			if (id && (!editing || editing.id !== id))
				throw new Error('Open this Pal’s customization again.')
			const saved = id
				? await api.updatePal(id, editing?.revision ?? 0, value)
				: await api.createPal(value)
			upsertPal(saved)
			setEditingPal(undefined)
			setCreatingPal(false)
			// Editing stays in the current conversation; its model choice is local.
			if (!id) await openPal(saved).catch((failure) => setError(errorText(failure)))
		} catch (failure) {
			setPalsError(errorText(failure))
		} finally {
			setPalsSaving(false)
		}
	}
	useEffect(() => {
		if (!pal?.id || palsPage || railSection === 'plugins' || project?.status !== 'ready') return
		// Explicit refresh invalidates a pending capture and starts a new read.
		void screenRefresh
		const id = pal.id
		const epoch = computerReadEpoch.current
		let current = true
		let timer: ReturnType<typeof setTimeout> | undefined
		const read = async () => {
			let ready = false
			try {
				if (document.hidden) return
				if (controlPending.current || startingComputers.current.has(id)) return
				const computer = await api.palComputer(id)
				if (
					!current ||
					epoch !== computerReadEpoch.current ||
					controlPending.current ||
					startingComputers.current.has(id)
				)
					return
				setPalComputers((all) => ({ ...all, [id]: computer }))
				if (computer.status !== 'ready' || !computer.generation) {
					setPalScreens((all) => ({
						...all,
						[id]: { generation: computer.generation },
					}))
					return
				}
				const generation = computer.generation
				ready = true
				// The content route uses a persistent RFB stream. PNG captures are
				// only for the small card thumbnail while the chat is visible.
				if (palScreen?.palId === id && palScreen.activeTab === 'computer') return
				setPalScreens((all) => ({
					...all,
					[id]:
						all[id]?.generation === generation
							? { ...all[id], loading: !all[id]?.screen }
							: { generation, loading: true },
				}))
				try {
					await captureFlight.current?.catch(() => {})
					if (
						!current ||
						epoch !== computerReadEpoch.current ||
						controlPending.current ||
						startingComputers.current.has(id)
					)
						return
					const capture = api.palScreen(id, generation)
					captureFlight.current = capture
					let screen: PalScreenView
					try {
						screen = await capture
					} finally {
						if (captureFlight.current === capture) captureFlight.current = undefined
					}
					if (current && epoch === computerReadEpoch.current)
						setPalScreens((all) => ({ ...all, [id]: { generation, screen } }))
				} catch (failure) {
					ready = false
					if (current && epoch === computerReadEpoch.current)
						setPalScreens((all) => ({
							...all,
							[id]: {
								generation,
								loading: false,
								error: errorText(failure),
							},
						}))
				}
			} catch (failure) {
				if (current && epoch === computerReadEpoch.current) {
					setPalComputers((all) => ({
						...all,
						[id]: { status: 'unavailable', notice: errorText(failure) },
					}))
					setPalScreens((all) => ({
						...all,
						[id]: { error: errorText(failure) },
					}))
				}
			} finally {
				if (current)
					timer = setTimeout(
						() => void read(),
						ready &&
							!document.hidden &&
							palScreen?.palId === id &&
							palScreen.activeTab === 'computer'
							? 1_000
							: 5_000,
					)
			}
		}
		void read()
		return () => {
			current = false
			if (timer) clearTimeout(timer)
		}
	}, [
		pal?.id,
		project?.status,
		palsPage,
		railSection,
		palScreen?.palId,
		palScreen?.activeTab,
		screenRefresh,
	])
	useEffect(() => {
		const wake = () => {
			if (!document.hidden) setScreenRefresh((value) => value + 1)
		}
		document.addEventListener('visibilitychange', wake)
		return () => document.removeEventListener('visibilitychange', wake)
	}, [])

	const startPalComputer = async (value: PalView) => {
		if (startingComputers.current.has(value.id)) return
		startingComputers.current.add(value.id)
		computerReadEpoch.current += 1
		setScreenRefresh((value) => value + 1)
		setPalComputers((all) => ({
			...all,
			[value.id]: { status: 'stopped', notice: 'Starting the local computer…' },
		}))
		try {
			const computer = await api.startPalComputer(value.id)
			setPalComputers((all) => ({ ...all, [value.id]: computer }))
			setScreenRefresh((value) => value + 1)
		} catch (failure) {
			setPalComputers((all) => ({
				...all,
				[value.id]: { status: 'unavailable', notice: errorText(failure) },
			}))
		} finally {
			startingComputers.current.delete(value.id)
			setScreenRefresh((value) => value + 1)
		}
	}
	const openPalScreen = (value: PalView) => {
		if (palScreen?.palId === value.id && palScreen.activeTab === 'computer') return
		invalidateComputerInput()
		setJobsOpen(false)
		setSideOpen(false)
		setPalScreen({ palId: value.id, activeTab: 'computer' })
	}
	const showPalChat = useCallback(() => {
		if (!palScreen || palScreen.activeTab === 'chat') return
		invalidateComputerInput()
		setPalScreen({ ...palScreen, activeTab: 'chat' })
	}, [palScreen, invalidateComputerInput])

	const ownedConversations = pal ? conversations.filter((item) => item.palId === pal.id) : []
	const palBusy = ownedConversations.some((item) => {
		const owned = threads[item.id]
		return owned && (owned.running || owned.queued.length > 0 || owned.permissions.length > 0)
	})
	const palComputer = pal ? palComputers[pal.id] : undefined
	const palCanWork =
		!pal ||
		(!pal.paused &&
			palComputer?.status === 'ready' &&
			(!palComputer.control?.supported || palComputer.control.mode === 'pal'))
	const computerCapture = pal ? palScreens[pal.id] : undefined
	const currentScreen =
		palComputer?.status === 'ready' && computerCapture?.generation === palComputer.generation
			? (computerCapture?.screen ?? null)
			: null
	const palWorkspace = !!pal && !palsPage && railSection === null
	const computerTabOpen = palWorkspace && palScreen?.palId === pal.id
	const computerPage = computerTabOpen && palScreen?.activeTab === 'computer'
	const chatMotion = useComputerChatMotion({
		enabled: computerPage,
		layout: computerChat,
		minimized: floatingChatMinimized,
		owner: pal?.id ?? projectId,
	})
	const setComputerChat = (next: React.SetStateAction<ComputerChatLayout>) => {
		retireComputerPendingInput()
		chatMotion.capture()
		setComputerChatState(next)
	}
	const setFloatingChatMinimized = (next: React.SetStateAction<boolean>) => {
		retireComputerPendingInput()
		chatMotion.capture()
		setFloatingChatMinimizedState(next)
	}
	const liveViewer = liveStream?.value
	const activeStream =
		liveStream?.palId === pal?.id && liveViewer?.generation === palComputer?.generation
			? (liveViewer ?? null)
			: null
	const livePalId = pal?.id
	const liveGeneration = palComputer?.generation
	const liveStatus = palComputer?.status
	useEffect(() => {
		invalidateComputerInput()
		if (!computerPage || !livePalId || liveStatus !== 'ready' || !liveGeneration) {
			setLiveStream(undefined)
			return
		}
		void streamRefresh
		const id = livePalId
		const generation = liveGeneration
		let current = true
		let viewer: PalComputerStreamView | undefined
		setLiveStream({ palId: id, loading: true })
		const open = async () => {
			try {
				if (!api.openPalComputerStream || !api.closePalComputerStream)
					throw new Error('Update the desktop app to enable live computer views.')
				viewer = await api.openPalComputerStream(id, generation)
				if (!current) {
					await api.closePalComputerStream(viewer.id)
					return
				}
				setLiveStream({ palId: id, value: viewer })
			} catch (failure) {
				if (current) setLiveStream({ palId: id, error: errorText(failure) })
			}
		}
		void open()
		return () => {
			current = false
			invalidateComputerInput()
			if (viewer)
				void api
					.closePalComputerStream?.(viewer.id)
					.catch((failure) => setError(errorText(failure)))
		}
	}, [computerPage, livePalId, liveStatus, liveGeneration, streamRefresh, invalidateComputerInput])
	const computerOwner = useRef<{
		id?: string
		generation?: string
		mode?: string
		status?: ComputerState['status']
		streamId?: string
		navigation: number
		visible: boolean
	}>({ navigation: 0, visible: false })
	computerOwner.current = {
		id: pal?.id,
		generation: palComputer?.generation,
		mode: palComputer?.control?.mode,
		status: palComputer?.status,
		streamId: activeStream?.id,
		navigation: navigation.current,
		visible: computerPage,
	}
	const inputQueue = useRef<ComputerInputQueue | null>(null)
	if (!inputQueue.current)
		inputQueue.current = new ComputerInputQueue(async (action, owner) => {
			const current = computerOwner.current
			if (
				!computerInputOwnerMatches(owner, {
					...current,
					viewEpoch: computerInputViewEpoch.current,
				}) ||
				navigation.current !== owner.navigation ||
				!current.visible ||
				current.status !== 'ready' ||
				!current.streamId ||
				current.streamId !== computerInputReadyStream.current ||
				current.mode !== 'operator' ||
				!document.hasFocus() ||
				!computerSurfaceOwnsFocus(document.activeElement) ||
				!api.palComputerInput
			)
				throw new ComputerInputRetiredError()
			await api.palComputerInput(owner.id, owner.generation, action)
		})
	const computerInputQueue = inputQueue.current
	const changeComputerControl = async (takeOver: boolean) => {
		const id = pal?.id
		const generation = palComputer?.generation
		const viewGeneration = navigation.current
		const viewEpoch = computerInputViewEpoch.current
		const operation = takeOver ? api.takeOverPalComputer : api.returnPalComputerControl
		if (!id || !generation || !operation || controlPending.current) return
		controlPending.current = true
		computerReadEpoch.current += 1
		setScreenRefresh((value) => value + 1)
		setControlBusy(true)
		try {
			await computerInputQueue.flush()
			await captureFlight.current?.catch(() => {})
			if (
				computerOwner.current.id !== id ||
				computerOwner.current.generation !== generation ||
				computerOwner.current.navigation !== viewGeneration ||
				navigation.current !== viewGeneration ||
				computerInputViewEpoch.current !== viewEpoch ||
				!computerOwner.current.visible
			)
				throw new Error('The computer view changed. Open it again to change control.')
			const state = await operation(id, generation)
			setPalComputers((all) => ({ ...all, [id]: state }))
			setScreenRefresh((value) => value + 1)
		} finally {
			controlPending.current = false
			setControlBusy(false)
			setScreenRefresh((value) => value + 1)
		}
	}
	const sendComputerInput = (action: PalComputerInput): Promise<void> => {
		const owner = { ...computerOwner.current }
		if (!document.hasFocus() || !computerSurfaceOwnsFocus(document.activeElement))
			return Promise.reject(new ComputerInputRetiredError())
		if (
			!owner.id ||
			!owner.generation ||
			!owner.visible ||
			owner.status !== 'ready' ||
			!owner.streamId ||
			owner.streamId !== computerInputReadyStream.current ||
			owner.mode !== 'operator' ||
			controlPending.current ||
			!api.palComputerInput
		)
			return Promise.reject(new Error('Take over this computer before sending input.'))
		const sequence = ++inputSequence.current
		setInputBusy(true)
		const operation = computerInputQueue.enqueue(action, {
			id: owner.id,
			generation: owner.generation,
			navigation: owner.navigation,
			viewEpoch: computerInputViewEpoch.current,
		})
		void operation
			.finally(() => {
				if (sequence === inputSequence.current) {
					setInputBusy(false)
				}
			})
			.catch(() => {})
		return operation
	}

	const palContextProps: PalContextProps | null = pal
		? {
				pal,
				status: pal.paused
					? 'paused'
					: palComputer?.control?.mode === 'operator'
						? 'operator'
						: palBusy
							? thread.permissions.length
								? 'approval'
								: 'working'
							: project?.status !== 'ready' || palComputer?.status !== 'ready'
								? 'offline'
								: 'idle',
				computer: {
					name: `${pal.name}’s computer`,
					workspace: pal.workspace,
					status:
						palComputer?.status === 'ready'
							? 'ready'
							: !palComputer || palComputer.notice === 'Starting the local computer…'
								? 'connecting'
								: 'error',
					screen: currentScreen,
					loading: computerCapture?.loading,
					notice:
						palComputer?.notice ??
						(palComputer?.status === 'stopped'
							? 'Start your Pal’s local computer to begin.'
							: undefined),
				},
				hostComputer: humanComputer,
				activity: [...ownedConversations].sort(compareConversationRecency).map((item) => ({
					id: item.id,
					title: item.title,
					status: threads[item.id]?.running ? 'working' : undefined,
				})),
				outputs: changes
					? [
							{
								id: sessionId,
								label: `${changes} changed ${changes === 1 ? 'file' : 'files'}`,
							},
						]
					: [],
				onCustomize: () => showPalEditor(pal),
				customizeDisabled: palBusy || palsSaving,
				onActivity: (id) => {
					const view = ownedConversations.find((item) => item.id === id)
					if (view) void act(() => openConversation(view))
				},
				onOutput: () => {
					setPanelTab('changes')
					setJobsOpen(true)
				},
				onPause: () =>
					void act(async () => {
						upsertPal(
							await api.updatePal(pal.id, pal.revision, {
								paused: !pal.paused,
							}),
						)
					}),
				pauseDisabled: palBusy || palsSaving,
				onStartComputer: pal.paused ? undefined : () => void startPalComputer(pal),
				onOpenComputer: () => void openPalScreen(pal),
				onStopComputer:
					palComputer?.status === 'ready' || palComputer?.requiresStop
						? () =>
								void act(async () => {
									computerReadEpoch.current += 1
									try {
										const stopped = await api.stopPalComputer(pal.id)
										setPalComputers((all) => ({ ...all, [pal.id]: stopped }))
									} finally {
										setScreenRefresh((value) => value + 1)
									}
								})
						: undefined,
				stopComputerDisabled: palBusy || controlBusy || inputBusy,
			}
		: null

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
				invalidateComputerInput()
				setPalScreen(undefined)
				setProjectId(destination.projectId)
				setSessionId('')
				setRailSection(null)
				setPalsPage(false)
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
	const showSpaces = () => {
		navigation.current += 1
		setPalScreen(undefined)
		setPalsPage(false)
		setRailSection('spaces')
		revealSidebar('[data-project-group] .project-row')
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
							options: {
								effort: item.effort,
								permissionMode: item.permissionMode ?? 'prompt',
							},
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
			(pal && (pal.paused || palComputer?.status !== 'ready')) ||
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
				const promotedSettings = savedSettings.save(target, {
					choice: route,
					options: settings,
				})
				sendingRef.current.add(target)
				setSending((all) => ({ ...all, [target]: true }))
				const draftWrites: Promise<void>[] = []
				if (generation === navigation.current) {
					draftWrites.push(api.saveDraft(owner, ''))
					draftsRef.current[owner] = ''
					setDrafts((all) => ({ ...all, [owner]: '' }))
					setSessionId(target)
					setConversationSelection({
						sessionId: target,
						collection: 'projects',
					})
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
			if (commandOpen || creatingPal || editingPal) return
			if (event.key === 'Escape') {
				if (computerPage) {
					showPalChat()
					return
				}
				if (sideOpen || jobsOpen) {
					setSideOpen(false)
					if (jobsOpen) closeDetails()
				} else if (thread.running && railSection !== 'plugins')
					void act(() => api.cancel(sessionId))
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
				if (!loading) void act(newConversation)
			}
			if (event.altKey && event.key === 'ArrowUp' && sessionId && railSection !== 'plugins') {
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
		creatingPal,
		editingPal,
		openCommands,
		loading,
		closeDetails,
		railSection,
		computerPage,
		showPalChat,
	])
	const shortcutModifier = /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'
	const commandItems: CommandPaletteItem[] = [
		...conversations
			.filter((view) => projects.some((item) => item.id === view.projectId))
			.sort(compareConversationRecency)
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
			disabled: loading,
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
		...projects
			.filter((item) => !item.palId && !item.isChat)
			.map((item) => ({
				id: `project:${item.id}`,
				label: item.name,
				group: 'Projects',
				icon: <FolderIcon aria-hidden="true" />,
				keywords: [item.path],
				onAction: () => {
					navigation.current += 1
					setProjectId(item.id)
					setSessionId('')
					setRailSection(null)
					setPalsPage(false)
					setSideOpen(false)
					setJobsOpen(false)
					input.current?.focus()
				},
			})),
	]
	return (
		<div
			className="app"
			data-sidebar-collapsed={sideCollapsed}
			data-page={
				railSection === 'plugins'
					? 'plugins'
					: palsPage
						? 'pals'
						: computerPage
							? 'computer'
							: 'chat'
			}
		>
			{(creatingPal || editingPal) && (
				<PalCustomizeDialog
					key={editingPal ? `${editingPal.id}:${editingPal.revision}` : 'new'}
					editing={editingPal}
					saving={palsSaving}
					error={palsError}
					model={draftPalModel}
					onModelChange={setDraftPalModel}
					onClose={() => {
						setCreatingPal(false)
						setEditingPal(undefined)
					}}
					onSave={savePal}
					loadProviders={api.palProviders}
					loadModels={api.palModels}
				/>
			)}

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
				newConversationDisabled={loading}
				onError={setError}
			/>
			<NavigationRail
				section={railSection ?? 'home'}
				appearance={appearance}
				onHome={() => {
					if (!loading) void act(newConversation)
				}}
				onSpaces={showSpaces}
				onAppearanceChange={setAppearance}
				onOpenProject={() => void act(openProject)}
				openProjectDisabled={loading}
				onToggleSidebar={toggleSidebar}
				onPlugins={() => {
					navigation.current += 1
					setPalScreen(undefined)
					setPluginSelection(undefined)
					setPalsPage(false)
					setRailSection('plugins')
					setJobsOpen(false)
					setSideOpen(false)
				}}
			/>
			<Sidebar
				activeProject={project}
				projects={projects.filter((item) => !item.palId)}
				pals={
					<PalSidebarSection
						pals={pals}
						selectedId={palsPage ? undefined : pal?.id}
						creating={palsPage}
						loading={palsLoading}
						onCreate={showPalOnboarding}
						onOpen={(value) => void act(() => openPal(value))}
					/>
				}
				conversations={conversations}
				projectId={palsPage ? '' : projectId}
				sessionId={palsPage ? '' : sessionId}
				conversationCollection={conversationCollection}
				threads={threads}
				open={railSection !== 'plugins' && sideOpen}
				collapsed={sideCollapsed}
				opening={loading}
				onClose={() => setSideOpen(false)}
				onOpenProject={() => void act(openProject)}
				onNewConversation={() => void act(newConversation)}
				onSearch={openCommands}
				onProject={selectProject}
				onConversation={(view, collection) => void act(() => openConversation(view, collection))}
			/>
			{railSection === 'plugins' && (
				<>
					{sideOpen && (
						<button
							type="button"
							className="scrim"
							aria-label="Close sidebar"
							onClick={() => setSideOpen(false)}
						/>
					)}
					<aside
						id="namzu-plugins-sidebar"
						className={`sidebar plugins-navigation-sidebar ${sideOpen ? 'open' : ''}`}
						inert={sideCollapsed && !sideOpen}
						aria-hidden={sideCollapsed && !sideOpen}
						aria-label="Customize"
					>
						<PluginsSidebar
							view={pluginStates[pluginsKey]?.value}
							loading={pluginStates[pluginsKey]?.loading ?? false}
							disabled={!project?.trusted || project.status !== 'ready'}
							contextLabel={project?.name}
							onChooseSpace={showSpaces}
							selected={selectedPlugin}
							onOpenPlugin={(plugin) => openPluginDetails(plugin, 'personal')}
							onBack={backToPlugins}
							onSearch={searchPlugins}
						/>
						<Button
							variant="ghost-muted"
							size="icon-xs"
							className="sidebar-close plugins-sidebar-close"
							aria-label="Close sidebar"
							onClick={() => setSideOpen(false)}
						>
							<XIcon />
						</Button>
					</aside>
				</>
			)}
			<main
				className={`workspace ${jobsOpen ? 'jobs-open' : ''}`}
				data-pal-workspace={palWorkspace}
				data-computer-chat={computerPage ? chatMotion.renderedLayout : undefined}
				data-chat-minimized={computerPage && floatingChatMinimized}
				data-page={
					railSection === 'plugins'
						? 'plugins'
						: palsPage
							? 'pals'
							: computerPage
								? 'computer'
								: 'chat'
				}
			>
				{palWorkspace && pal && (
					<ComputerWorkspaceToolbar
						palName={pal.name}
						paused={pal.paused}
						busy={palBusy || controlBusy || palsSaving}
						activeTab={computerPage ? 'computer' : 'chat'}
						computerTabOpen={computerTabOpen}
						profileOpen={computerPage ? computerProfileOpen : palProfileOpen}
						split={computerPage && computerChat === 'split'}
						chatOpen={computerChat !== 'hidden'}
						floating={computerChat === 'floating'}
						onRename={() => showPalEditor(pal)}
						onPause={palContextProps?.onPause}
						onReboot={
							palComputer?.status === 'ready' && !pal.paused && api.rebootPalComputer
								? () =>
										void act(async () => {
											controlPending.current = true
											setControlBusy(true)
											computerReadEpoch.current += 1
											try {
												await computerInputQueue.flush()
												const generation = palComputer.generation
												if (!generation || !api.rebootPalComputer)
													throw new Error('Computer reboot is unavailable.')
												const state = await api.rebootPalComputer(pal.id, generation)
												setPalComputers((all) => ({ ...all, [pal.id]: state }))
											} finally {
												controlPending.current = false
												setControlBusy(false)
												setScreenRefresh((value) => value + 1)
											}
										})
								: undefined
						}
						onOpenChat={showPalChat}
						onToggleProfile={() => {
							if (computerPage) setComputerProfileOpen((value) => !value)
							else setPalProfileOpen((value) => !value)
						}}
						onOpenComputer={() => {
							openPalScreen(pal)
							setFloatingChatMinimized(false)
						}}
						onCloseComputer={() => {
							invalidateComputerInput()
							setPalScreen(undefined)
							requestAnimationFrame(() =>
								document.getElementById('pal-chat-tab')?.focus({ preventScroll: true }),
							)
						}}
						onToggleChat={() => {
							setComputerChat((value) => (value === 'hidden' ? 'split' : 'hidden'))
							setFloatingChatMinimized(false)
						}}
						onToggleFloating={() => {
							setComputerChat((value) => (value === 'floating' ? 'split' : 'floating'))
							setFloatingChatMinimized(false)
						}}
					/>
				)}
				{computerPage && pal && palContextProps && (
					<PalComputerView
						id="pal-computer-panel"
						aria-labelledby="computer-tab"
						role="tabpanel"
						key={`${pal.id}:${palComputer?.generation ?? 'offline'}`}
						palName={pal.name}
						computer={{
							...palContextProps.computer,
							notice: liveStream?.error ?? palContextProps.computer.notice,
						}}
						screen={null}
						stream={activeStream}
						hideHeader
						loading={liveStream?.loading ?? false}
						onStreamReady={(id) => {
							if (computerOwner.current.streamId === id) computerInputReadyStream.current = id
						}}
						onStreamDisconnected={(id) => {
							if (computerOwner.current.streamId === id) invalidateComputerInput()
							void api.closePalComputerStream?.(id).catch((failure) => setError(errorText(failure)))
						}}
						control={palComputer?.control}
						controlBusy={controlBusy}
						inputBusy={inputBusy}
						onBack={showPalChat}
						onRefresh={() => {
							invalidateComputerInput()
							setStreamRefresh((value) => value + 1)
						}}
						onStart={palContextProps.onStartComputer}
						onTakeOver={
							api.takeOverPalComputer
								? () => void act(() => changeComputerControl(true))
								: undefined
						}
						onRelease={
							api.returnPalComputerControl
								? () => void act(() => changeComputerControl(false))
								: undefined
						}
						onInput={api.palComputerInput ? sendComputerInput : undefined}
						onKeyboardFocus={(enabled) => {
							void api
								.setComputerKeyboardCapture?.(enabled)
								.catch((failure) => setError(errorText(failure)))
						}}
					/>
				)}
				{computerPage &&
					(computerChat === 'hidden' || (computerChat === 'floating' && floatingChatMinimized)) && (
						<Button
							variant="glass"
							size="icon-sm"
							className="computer-chat-launcher"
							aria-label={floatingChatMinimized ? 'Restore chat' : 'Open floating chat'}
							onClick={() => {
								setComputerChat('floating')
								setFloatingChatMinimized(false)
							}}
						>
							<MessageSquare aria-hidden="true" />
						</Button>
					)}
				{computerPage && computerChat === 'hidden' && computerProfileOpen && palContextProps && (
					<div className="computer-profile-overlay">
						<PalContextCard {...palContextProps} />
					</div>
				)}
				{railSection === 'plugins' && (
					<PluginsPage
						scope={pluginsKey}
						view={pluginStates[pluginsKey]?.value}
						loading={pluginStates[pluginsKey]?.loading ?? false}
						disabled={!project?.trusted || project.status !== 'ready'}
						contextLabel={project?.name}
						onLoad={loadPlugins}
						onSetEnabled={setPluginEnabled}
						onChooseSpace={showSpaces}
						collection={pluginCollection}
						onCollectionChange={(collection) => {
							setPluginSelection(undefined)
							setPluginCollection(collection)
						}}
						selected={selectedPlugin}
						onOpenPlugin={openPluginDetails}
						onTryPlugin={tryPlugin}
						onBack={backToPlugins}
					/>
				)}
				{palsPage && (
					<PalsPage
						model={draftPalModel}
						onModelChange={setDraftPalModel}
						onCustomize={() => showPalEditor()}
						loadProviders={api.palProviders}
						loadModels={api.palModels}
					/>
				)}
				<WorkspacePageHeader className="topbar">
					<WorkspaceBreadcrumb ariaLabel="Conversation breadcrumb" className="breadcrumb flex-1">
						<WorkspaceBreadcrumbItem className="breadcrumb-project shrink">
							<WorkspaceBreadcrumbText className="max-w-40" data-project-label>
								{pal?.name ?? project?.name ?? 'Workspace'}
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
					{sessionId && (
						<>
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
								aria-pressed={jobsOpen && panelTab === 'changes'}
								onClick={() => {
									setPanelTab('changes')
									setJobsOpen(panelTab !== 'changes' || !jobsOpen)
								}}
							>
								<FileDiffIcon className="size-4" />
							</Button>
							{!pal && contextProps && thread.messages.length > 0 && (
								<ProjectContextMenu {...contextProps} />
							)}
						</>
					)}
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
						ref={chatMotion.stageRef}
						inert={computerPage && !chatMotion.interactive}
						aria-hidden={computerPage && !chatMotion.interactive ? true : undefined}
						id={palWorkspace ? 'pal-chat-panel' : undefined}
						role={palWorkspace ? 'tabpanel' : undefined}
						aria-labelledby={palWorkspace ? 'pal-chat-tab' : undefined}
						data-empty={!pal && thread.messages.length === 0}
						data-context-card={!jobsOpen && !pal && thread.messages.length > 0}
						data-pal-context={Boolean(palContextProps) && !computerPage && palProfileOpen}
					>
						{!pal && contextProps && thread.messages.length > 0 && !jobsOpen && (
							<ProjectContextCard {...contextProps} />
						)}
						{palContextProps && !computerPage && palProfileOpen && (
							<PalContextCard {...palContextProps} />
						)}
						{palContextProps &&
							computerPage &&
							computerChat !== 'hidden' &&
							computerProfileOpen && (
								<div className="computer-profile-overlay">
									<PalContextCard {...palContextProps} />
								</div>
							)}
						{computerPage && (
							<header className="computer-floating-chat-heading">
								<Button
									variant="ghost-muted"
									size="icon-xs"
									aria-label="Minimize chat"
									onClick={() => setFloatingChatMinimized(true)}
								>
									<Minus aria-hidden="true" />
								</Button>
								<span>Chat</span>
								<Button
									variant="ghost-muted"
									size="icon-xs"
									aria-label="Dock chat panel"
									onClick={() => {
										setComputerChat('split')
										setFloatingChatMinimized(false)
									}}
								>
									<PanelLeftIcon />
								</Button>
							</header>
						)}
						<div className="conversation-lane">
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
									{pal && thread.messages.length === 0 && (
										<PalWelcome
											pal={pal}
											disabled={palBusy}
											onCustomize={() => showPalEditor(pal)}
										/>
									)}
									{thread.partial && (
										<p className="notice">
											Showing the latest part of this conversation. The full record remains on this
											device.
										</p>
									)}
									<Transcript key={sessionId || 'blank'} thread={thread} />
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
								</div>
							</div>
							<Composer
								variant={pal ? 'pal' : 'default'}
								inputRef={input}
								permissions={thread.permissions}
								onApproval={(permission, approved) =>
									void act(() => api.approve(permission.sessionId, permission.id, approved))
								}
								projectName={project.name}
								projectId={project.id}
								sessionId={sessionId || undefined}
								projectPath={project.path}
								harness={{
									label: 'Namzu',
									status: project.status === 'ready' ? 'ready' : 'unavailable',
									detail:
										project.status === 'ready'
											? 'Namzu runs this conversation with your selected model provider.'
											: 'Reconnect this project to use Namzu.',
								}}
								projects={projects.filter((item) => !item.palId)}
								onSelectProject={(item) => selectProject(item.id)}
								onOpenProject={() => void act(openProject)}
								empty={!pal && thread.messages.length === 0}
								draft={draft}
								onDraftChange={(value) => changeDraft(draftOwner, value)}
								providers={activeProviders}
								modelSelectionReady={
									project.status === 'ready' &&
									providerReady &&
									project.trusted &&
									!savedSettings.loading
								}
								connected={
									project.status === 'ready' &&
									palCanWork &&
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
								onSetPluginEnabled={setPluginEnabled}
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
									<JobRow
										key={job.id}
										job={job}
										onRead={() =>
											void act(async () => {
												const target = sessionId
												const generation = navigation.current
												try {
													const output = await api.readJob(target, job.id)
													if (activeSession.current !== target || generation !== navigation.current)
														return
													setJobOutput(
														`${output.truncated ? 'Earlier output omitted.\n' : ''}${output.output}`,
													)
												} catch (failure) {
													if (activeSession.current === target && generation === navigation.current)
														throw failure
												}
											})
										}
										onStop={() => void act(() => api.stopJob(sessionId, job.id))}
									/>
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
