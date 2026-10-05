import { MessageSquare, Minus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { resolveComposerSendOptions } from '../shared/composer-send-options.js'
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
	HarnessView,
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
import { ComputerKeyboardOwners } from './computer-keyboard-owner.js'
import { computerWorkspaceIds } from './computer-workspace-toolbar.js'
import { compareConversationRecency } from './conversation-order.js'
import { type ConversationPalWorkspace, ConversationTabs } from './conversation-tabs.js'
import { ConversationTasks, TasksProgress } from './conversation-tasks.js'
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
import { PalActivity, palToolActivity } from './pal-activity.js'
import { PalChatTranscript } from './pal-chat-transcript.js'
import { PalComputerView } from './pal-computer-view.js'
import { PalContextCard, type PalContextProps } from './pal-context.js'
import { PalCustomizeDialog, PalSidebarSection, PalsPage } from './pals-page.js'
import { PluginsPage, PluginsSidebar } from './plugins-page.js'
import { ProjectContextCard, ProjectContextMenu } from './project-context.js'
import { type ConversationCollection, Sidebar } from './sidebar.js'
import { Transcript } from './transcript.js'
import { TurnRecovery } from './turn-recovery.js'
import { Button } from './ui/button.js'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty.js'
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
import { createWorkspacePaneApi } from './workspace-pane-api.js'
import type { WorkspacePaneProps } from './workspace-pane-types.js'
import { readWorkspacePresentation, writeWorkspacePresentation } from './workspace-presentation.js'
import { WorkspaceSessionCache } from './workspace-session-cache.js'

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
export function App({
	group,
	windowId,
	focused,
	shell,
	frozen: externalFrozen,
	appearance,
	onAppearanceChange,
	sideCollapsed,
	onSideCollapsedChange,
	onShellState,
	onAction,
	registerController,
	onReady,
	onLoadFailure,
	onComputerFocus,
	onDetach,
	onSplit,
}: WorkspacePaneProps) {
	const [localFrozen, setLocalFrozen] = useState(false)
	const frozen = externalFrozen || localFrozen
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		facade.current?.activate()
		return () => {
			facade.current?.invalidate()
			mounted.current = false
		}
	}, [])
	const computerIds = computerWorkspaceIds(`${windowId}-${group.id}`)
	const paneRoot = useRef<HTMLElement>(null)
	const context = useRef({ group, focused, frozen })
	context.current = { group, focused, frozen }
	const createdSessions = useRef(new Set<string>())
	for (const id of group.tabs) createdSessions.current.delete(id)
	const operations = useRef(new Set<Promise<unknown>>())
	const facade = useRef<ReturnType<typeof createWorkspacePaneApi> | null>(null)
	if (!facade.current)
		facade.current = createWorkspacePaneApi(window.namzu, {
			owns: (target) =>
				mounted.current &&
				(target.startsWith('project:') ||
					context.current.group.tabs.includes(target) ||
					createdSessions.current.has(target)),
			blocked: () => !mounted.current || (context.current.frozen && operations.current.size === 0),
			beforeNewConversation: async () => {
				await onAction({ kind: 'focus', groupId: context.current.group.id })
			},
			created: (id) => {
				createdSessions.current.add(id)
				hydratedSession.current = id
			},
		})
	const api = facade.current.api
	const [projectsLoaded, setProjectsLoaded] = useState(false)
	const [catalogueReady, setCatalogueReady] = useState(false)
	const catalogueTabsKey = JSON.stringify(group.tabs)
	const catalogueOwner = useRef<{ projects: unknown; tabsKey: string } | null>(null)
	const activation = useRef<string | null>(null)
	const missingActivation = useRef<string | null>(null)
	const hydratedSession = useRef<string | null>(null)
	const warmSessions = useRef(
		new WorkspaceSessionCache<{
			providers: ProviderView
			harness?: HarnessView
			modelSettings: Map<string, ComposerModelSettings>
		}>(),
	)
	const [metadataEpoch, setMetadataEpoch] = useState(0)
	warmSessions.current.synchronizeMembers([...group.tabs, ...createdSessions.current])
	const openFlights = useRef(new Map<string, { generation: number; promise: Promise<void> }>())
	const previousMembership = useRef(group.tabs)
	if (
		hydratedSession.current &&
		previousMembership.current.includes(hydratedSession.current) &&
		!group.tabs.includes(hydratedSession.current)
	)
		hydratedSession.current = null
	previousMembership.current = group.tabs
	const openingHistory = useRef<number | null>(null)
	const writePresentation = useRef<() => void>(() => {})

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
			if (
				!context.current.focused ||
				context.current.frozen ||
				!paneRoot.current?.contains(document.activeElement) ||
				!computerSurfaceOwnsFocus(document.activeElement)
			)
				retireComputerPendingInput()
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
	useEffect(() => {
		if (projectId) return
		const first = projects.find((item) => !item.palId)
		if (first) setProjectId(first.id)
	}, [projects, projectId])
	const [, setOpenTabIds] = useState<string[]>([])
	const [loading, setLoading] = useState(false)
	const [, setTabsRestored] = useState(false)
	const [restoringTabs, setRestoringTabs] = useState(true)
	const [tabRestoreAttempt, setTabRestoreAttempt] = useState(0)
	const abandonTabRestore = useCallback(() => {
		// Deliberate navigation also retires the previous view's pending load.
		setLoading(false)
		setRestoringTabs(false)
		setTabsRestored(true)
	}, [])
	const closedTabs = useRef(new Set<string>())
	const providerGeneration = useRef(0)
	const harnessGeneration = useRef(0)
	const [harnessState, setHarnessState] = useState<{
		owner: string
		view: HarnessView
	}>()
	const [harnessBusy, setHarnessBusy] = useState(false)
	const harnessChoicePending = useRef(false)
	const harnessChoiceFailure = useRef<{ sessionId: string; message: string } | null>(null)
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
	}, [projects, api])
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
	const setSideCollapsed = onSideCollapsedChange
	const toggleSidebar = useCallback(() => {
		if (window.matchMedia('(max-width: 767px)').matches) setSideOpen((value) => !value)
		else
			setSideCollapsed((value) => {
				localStorage.setItem('namzu.sidebar-collapsed', String(!value))
				return !value
			})
	}, [setSideCollapsed])
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
			if (
				!context.current.focused ||
				context.current.frozen ||
				event.isComposing ||
				event.keyCode === 229 ||
				event.defaultPrevented
			)
				return
			if (commandOpen) return
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && !event.altKey) {
				event.preventDefault()
				toggleSidebar()
			}
		}
		window.addEventListener('keydown', key)
		return () => window.removeEventListener('keydown', key)
	}, [toggleSidebar, commandOpen])
	const setAppearance = onAppearanceChange
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
			if (railSection !== null || palsPage || palScreen?.palId !== project?.palId)
				setPalScreen(undefined)
		}
	}, [routeKey, railSection, palsPage, palScreen?.palId, project?.palId])
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
	}, [api])
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
	const harnessView = harnessState?.owner === providerKey ? harnessState.view : undefined
	const permissionEngine = pal
		? 'namzu'
		: (harnessView?.selected ?? conversation?.harness ?? 'namzu')
	const externalHarness = permissionEngine !== 'namzu'
	const normalTabs = group.tabs.map(
		(id): ConversationView =>
			conversations.find((item) => item.id === id) ?? {
				id,
				projectId: '',
				title: 'Conversation',
				updatedAt: '',
			},
	)
	const draftOwner = sessionId || `project:${projectId}:workspace:${windowId}:${group.id}`
	const draft = drafts[draftOwner] ?? ''
	const attached = useAttachments(
		draftOwner,
		Boolean(project),
		(failure) => setError(errorText(failure)),
		api,
	)
	const savedSettings = useDraftSettings(
		draftOwner,
		Boolean(project),
		(failure) => setError(errorText(failure)),
		api,
	)
	const settings = resolveComposerSendOptions(savedSettings.value.options, pal?.id)
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
	const modelSettingsBusy =
		harnessBusy ||
		loading ||
		restoringTabs ||
		savedSettings.loading ||
		Boolean(sending[draftOwner]) ||
		thread.running
	const capabilities = modelSettings?.key === modelSettingsKey ? modelSettings.value : null
	const warmSession = warmSessions.current.read(sessionId, projectId)
	if (warmSession) {
		if (providerReady) warmSession.providers = providers
		if (harnessView) warmSession.harness = harnessView
		if (capabilities) warmSession.modelSettings.set(modelSettingsKey, capabilities)
	}
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
			pal ||
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
			paneRoot.current
				?.querySelector<HTMLTextAreaElement>('.composer-input')
				?.focus({ preventScroll: true })
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
	}, [projectId, sessionId, pluginsKey, api])
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
		if (!projectId || !providerReady || !choice.provider || !modelId || modelSettingsBusy) return
		const remembered = warmSessions.current
			.read(sessionId, projectId)
			?.modelSettings.get(modelSettingsKey)
		if (remembered) {
			if (modelSettings?.key !== modelSettingsKey || modelSettings.value !== remembered)
				setModelSettings({ key: modelSettingsKey, value: remembered })
			return
		}
		if (modelSettings?.key === modelSettingsKey) return
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
	}, [
		projectId,
		sessionId,
		providerReady,
		choice.provider,
		modelId,
		modelSettingsKey,
		modelSettingsBusy,
		modelSettings,
		api,
	])
	const updateProject = useCallback(
		(item: ProjectView) =>
			setProjects((items) => [...items.filter((row) => row.id !== item.id), item]),
		[],
	)
	const act = useCallback(async (action: () => Promise<unknown>) => {
		if (context.current.frozen) return
		harnessChoiceFailure.current = null
		setError('')
		const pending = Promise.resolve().then(action)
		operations.current.add(pending)
		try {
			await pending
		} catch (failure) {
			setError(errorText(failure))
		} finally {
			operations.current.delete(pending)
		}
	}, [])
	const retryConversationSetup = async () => {
		if (!project || !project.trusted || project.status !== 'ready' || harnessBusy) return
		const owner = providerKey
		const epoch = ++providerGeneration.current
		const harnessEpoch = ++harnessGeneration.current
		warmSessions.current.read(sessionId, projectId)?.modelSettings.clear()
		setModelSettings(null)
		savedSettings.retry()
		await Promise.all([
			api.providers(project.id, sessionId || undefined).then((available) => {
				if (providerReadOwner.current !== owner || providerGeneration.current !== epoch) return
				setProviders(available)
				setProviderOwner(owner)
			}),
			!pal && api.harnesses
				? api.harnesses(project.id, sessionId || undefined).then((view) => {
						if (providerReadOwner.current !== owner || harnessGeneration.current !== harnessEpoch)
							return
						setHarnessState({ owner, view })
					})
				: Promise.resolve(),
		])
	}
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
	}, [api])
	useEffect(() => {
		if (!api) {
			setError('Open Namzu using the desktop application.')
			return
		}
		return api.onEvent((event: DesktopEvent) => {
			if (event.kind === 'workspace') return
			if (event.kind === 'connection') {
				warmSessions.current.invalidateProject(event.project.id)
				if (
					providerReadOwner.current === JSON.stringify([event.project.id, activeSession.current])
				) {
					providerGeneration.current++
					harnessGeneration.current++
					hydratedSession.current = null
					activation.current = null
					setProviderOwner('')
					setHarnessState(undefined)
					setModelSettings(null)
				}
				updateProject(event.project)
				return
			}
			const id = event.kind === 'permission' ? event.request.sessionId : event.sessionId
			const read = snapshotRead.current
			if (
				!context.current.group.tabs.includes(id) &&
				read?.sessionId !== id &&
				activeSession.current !== id
			) {
				if (event.kind === 'state')
					setThreads((all) => ({
						...all,
						[id]: { ...(all[id] ?? emptyThread()), running: event.running },
					}))
				return
			}
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
	}, [updateProject, attached.reload, api])
	useEffect(() => {
		// Choice settlement resumes metadata admission even for the same active ID.
		void metadataEpoch
		if (!project || project.status === 'connecting' || !project.trusted) return
		if (warmSessions.current.mutating(sessionId)) return
		const remembered = warmSessions.current.read(sessionId, project.id)
		if (remembered) {
			setProviders(remembered.providers)
			setProviderOwner(JSON.stringify([project.id, sessionId]))
			return
		}
		if (openingHistory.current !== null) return
		let current = true
		const owner = JSON.stringify([project.id, sessionId])
		const epoch = ++providerGeneration.current
		void api
			.providers(project.id, sessionId || undefined)
			.then((available) => {
				if (!current || providerReadOwner.current !== owner || providerGeneration.current !== epoch)
					return
				setProviders(available)
				setProviderOwner(owner)
			})
			.catch((failure) => {
				if (current && providerReadOwner.current === owner) setError(errorText(failure))
			})
		return () => {
			current = false
		}
	}, [project, sessionId, api, metadataEpoch])
	useEffect(() => {
		if (!projectId || !api) return
		let current = true
		const owner = `project:${projectId}:workspace:${windowId}:${group.id}`
		if (draftsRef.current[owner] !== undefined) return
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
	}, [projectId, windowId, group.id, api])
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
	}, [sessionId, api])
	useEffect(() => {
		if (!sessionId || !jobsOpen || panelTab !== 'jobs' || !api?.refreshTasks) return
		let current = true
		void api.refreshTasks(sessionId).catch((failure) => {
			if (current) setError(errorText(failure))
		})
		return () => {
			current = false
		}
	}, [sessionId, jobsOpen, panelTab, api])
	useEffect(() => {
		const node = transcript.current
		if (!node || !sessionId) return
		let scrollFrame: number | undefined
		const observer = new ResizeObserver(() => {
			if (scrollFrame !== undefined) return
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = undefined
				if (!follow.current) return
				const bottom = Math.max(0, node.scrollHeight - node.clientHeight)
				if (Math.abs(node.scrollTop - bottom) > 0.5) node.scrollTop = bottom
			})
		})
		observer.observe(node)
		if (node.firstElementChild) observer.observe(node.firstElementChild)
		return () => {
			observer.disconnect()
			if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
		}
	}, [sessionId])
	useEffect(() => {
		if (
			!pal &&
			sessionId &&
			!closedTabs.current.has(sessionId) &&
			conversations.some((view) => view.id === sessionId && !view.palId)
		)
			setOpenTabIds((all) => (all.includes(sessionId) ? all : [...all, sessionId]))
	}, [sessionId, pal, conversations])
	useEffect(() => {
		void metadataEpoch
		if (!api.harnesses || !project || pal || !project.trusted || project.status !== 'ready') return
		if (warmSessions.current.mutating(sessionId)) return
		const remembered = warmSessions.current.read(sessionId, project.id)?.harness
		if (remembered) {
			setHarnessState({ owner: providerKey, view: remembered })
			return
		}
		let current = true
		const owner = providerKey
		const epoch = ++harnessGeneration.current
		void api
			.harnesses(project.id, sessionId || undefined)
			.then((view) => {
				if (current && providerReadOwner.current === owner && harnessGeneration.current === epoch)
					setHarnessState({ owner, view })
			})
			.catch((failure) => {
				if (current) setError(errorText(failure))
			})
		return () => {
			current = false
		}
	}, [project, pal, sessionId, providerKey, api, metadataEpoch])
	const newConversation = useCallback(async () => {
		abandonTabRestore()
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
			if (destination.trusted && destination.status === 'ready') {
				const view = await api.newConversation(destination.id)
				setConversations((all) => [view, ...all.filter((item) => item.id !== view.id)])
				setThreads((all) => ({ ...all, [view.id]: emptyThread() }))
				setOpenTabIds((all) => [...all, view.id])
				if (generation !== navigation.current) return
				setSessionId(view.id)
			} else setSessionId('')
			setConversationSelection(null)
			setError('')
			setPalScreen(undefined)
			setRailSection(null)
			setPalsPage(false)
			setSideOpen(false)
			setJobsOpen(false)
			requestAnimationFrame(() => input.current?.focus())
		} finally {
			if (generation === navigation.current) setLoading(false)
		}
	}, [projects, projectId, updateProject, abandonTabRestore, api])

	const selectHarness = async (engine: HarnessView['selected']) => {
		if (
			!api.selectHarness ||
			!project ||
			pal ||
			harnessBusy ||
			harnessChoicePending.current ||
			thread.running ||
			loading ||
			restoringTabs
		)
			return
		if ((harnessView?.selected ?? 'namzu') === engine) return
		const generation = navigation.current
		const sourceProject = project
		const sourceOwner = draftOwner
		const capturedDraft = draftsRef.current[sourceOwner] ?? ''
		let target = sessionId
		let finishMutation: (() => void) | undefined
		harnessChoicePending.current = true
		setHarnessBusy(true)
		try {
			const create = !target || harnessView?.locked || thread.messages.length > 0
			if (create) {
				const view = await api.newConversation(sourceProject.id)
				target = view.id
				setConversations((all) => [view, ...all.filter((item) => item.id !== view.id)])
				setThreads((all) => ({ ...all, [view.id]: emptyThread() }))
				setOpenTabIds((all) => (all.includes(view.id) ? all : [...all, view.id]))
				if (!sessionId) {
					const current = generation === navigation.current
					const text = current ? (draftsRef.current[sourceOwner] ?? capturedDraft) : capturedDraft
					draftsRef.current[target] = text
					setDrafts((all) => ({ ...all, [target]: text }))
					if (current) {
						setSessionId(target)
						draftsRef.current[sourceOwner] = ''
						setDrafts((all) => ({ ...all, [sourceOwner]: '' }))
						await Promise.all([api.saveDraft(target, text), api.saveDraft(sourceOwner, '')])
						await attached.promote(sourceOwner, target)
					} else await api.saveDraft(target, text)
				}
				if (generation === navigation.current) setSessionId(target)
			}
			finishMutation = warmSessions.current.beginMutation(target)
			setMetadataEpoch((epoch) => epoch + 1)
			const view = await api.selectHarness(target, engine)
			setConversations((all) =>
				all.map((item) => (item.id === target ? { ...item, harness: view.selected } : item)),
			)
			const owner = JSON.stringify([sourceProject.id, target])
			if (generation === navigation.current) {
				harnessGeneration.current++
				providerGeneration.current++
				setHarnessState({ owner, view })
				setProviderOwner('')
				setSessionId(target)
				setConversationSelection({ sessionId: target, collection: 'projects' })
				setRailSection(null)
				setJobsOpen(false)
			}
			await savedSettings.save(target, {
				options: { permissionMode: 'prompt' },
			})
			const available = await api.providers(sourceProject.id, target)
			if (generation !== navigation.current) return
			setProviders(available)
			setProviderOwner(owner)
		} catch (failure) {
			if (finishMutation)
				harnessChoiceFailure.current = { sessionId: target, message: errorText(failure) }
			throw failure
		} finally {
			harnessChoicePending.current = false
			setHarnessBusy(false)
			if (finishMutation) {
				// A user may return to this owner while its choice ACK is pending.
				// Retire visible metadata before waking that activation, regardless
				// of the navigation generation which initiated the mutation.
				if (activeSession.current === target || context.current.group.activeTabId === target) {
					providerGeneration.current++
					harnessGeneration.current++
					hydratedSession.current = null
					activation.current = null
					setProviderOwner('')
					setHarnessState(undefined)
					setModelSettings(null)
					setRestoringTabs(true)
				}
				setMetadataEpoch((epoch) => epoch + 1)
				finishMutation()
			}
		}
	}

	const createProjectDraft = useCallback(
		async (item: ProjectView) => {
			if (!item.trusted || item.status !== 'ready') return ''
			const view = await api.newConversation(item.id)
			setConversations((all) => [view, ...all.filter((row) => row.id !== view.id)])
			setThreads((all) => ({ ...all, [view.id]: emptyThread() }))
			return view.id
		},
		[api],
	)
	const openProject = useCallback(async () => {
		abandonTabRestore()
		const generation = ++navigation.current
		setLoading(true)
		try {
			const item = await api.openProject()
			if (item) {
				updateProject(item)
				if (generation !== navigation.current) return
				const target = await createProjectDraft(item)
				if (generation !== navigation.current) return
				setProjectId(item.id)
				setSessionId(target)
				setConversationSelection(null)
				setPalScreen(undefined)
				setRailSection(null)
				setPalsPage(false)
				setSideOpen(false)
				setJobsOpen(false)
				if (context.current.focused && !context.current.frozen) input.current?.focus()
			}
		} catch (failure) {
			if (generation === navigation.current) throw failure
		} finally {
			if (generation === navigation.current) setLoading(false)
		}
	}, [updateProject, abandonTabRestore, createProjectDraft, api])
	const leaveProject = async () => {
		if (!api.openChat) throw new Error('Restart the desktop app to open a normal conversation.')
		abandonTabRestore()
		const generation = ++navigation.current
		setLoading(true)
		try {
			const item = await api.openChat()
			updateProject(item)
			if (generation !== navigation.current) return
			const target = await createProjectDraft(item)
			if (generation !== navigation.current) return
			setProjectId(item.id)
			setSessionId(target)
			setConversationSelection(null)
			setPalScreen(undefined)
			setRailSection(null)
			setPalsPage(false)
			setSideOpen(false)
			setJobsOpen(false)
			requestAnimationFrame(() => input.current?.focus())
		} finally {
			if (generation === navigation.current) setLoading(false)
		}
	}
	const selectProject = async (id: string) => {
		const item = projects.find((item) => item.id === id)
		if (!item || context.current.frozen) return
		abandonTabRestore()
		const generation = ++navigation.current
		setLoading(true)
		try {
			const target = await createProjectDraft(item)
			if (generation !== navigation.current) return
			setProjectId(id)
			setSessionId(target)
			setConversationSelection(null)
			setPalScreen(undefined)
			setRailSection(null)
			setPalsPage(false)
			setSideOpen(false)
			setJobsOpen(false)
		} finally {
			if (generation === navigation.current) setLoading(false)
		}
	}
	const openConversation = useCallback(
		(
			view: ConversationView,
			collection: ConversationCollection = 'projects',
			restoring = false,
		) => {
			const flight = openFlights.current.get(view.id)
			if (flight?.generation === navigation.current) return flight.promise
			const generation = ++navigation.current
			const pending = (async () => {
				writePresentation.current()
				if (!restoring) {
					if (context.current.frozen) return
					const next = await onAction({
						kind: 'open',
						tabId: view.id,
						groupId: context.current.group.id,
					})
					const destination = next.layout.windows.find((item) => item.id === windowId)
					if (
						generation !== navigation.current ||
						destination?.focusedGroupId !== context.current.group.id
					)
						return
					abandonTabRestore()
				}
				closedTabs.current.delete(view.id)
				setPalScreen(undefined)
				if (snapshotRead.current) snapshotRead.current.events.length = 0
				await warmSessions.current.whenSettled(view.id)
				if (generation !== navigation.current) return
				openingHistory.current = generation
				const remembered = warmSessions.current.read(view.id, view.projectId)
				const ticket = warmSessions.current.ticket(view.id, view.projectId)
				const read = {
					generation,
					sessionId: view.id,
					events: [] as DesktopEvent[],
					characters: 0,
					overflow: false,
				}
				snapshotRead.current = remembered ? null : read
				try {
					let status = remembered?.providers
					if (!remembered) {
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
						const [available, savedDraft] = await Promise.all([
							api.providers(view.projectId, view.id),
							api.draft(view.id),
						])
						status = available
						if (restoring || draftsRef.current[view.id] === undefined) {
							draftsRef.current[view.id] = savedDraft
							setDrafts((all) => ({ ...all, [view.id]: savedDraft }))
						}
						if (generation !== navigation.current) return
						await Promise.all([savedSettings.refresh(view.id), attached.reload(view.id)])
						if (generation !== navigation.current) return
						if (
							!warmSessions.current.remember(ticket, {
								providers: available,
								modelSettings: new Map(),
							})
						)
							throw new Error(
								'This conversation’s connection or pane changed while opening. Try again.',
							)
					}
					if (!status) return
					hydratedSession.current = view.id
					setError(
						harnessChoiceFailure.current?.sessionId === view.id
							? harnessChoiceFailure.current.message
							: '',
					)
					setProviders(status)
					setProviderOwner(JSON.stringify([view.projectId, view.id]))
					setSessionId(view.id)
					setConversationSelection({ sessionId: view.id, collection })
					setProjectId(view.projectId)
					setRailSection(null)
					setPalsPage(false)
					setSideOpen(false)
					const presentation =
						restoring || remembered
							? readWorkspacePresentation(localStorage, view.id, view.palId)
							: null
					if (presentation) {
						setPalScreen(
							!restoring && presentation.palScreen
								? { ...presentation.palScreen, activeTab: 'chat' }
								: presentation.palScreen,
						)
						setComputerChatState(presentation.computerChat)
						setFloatingChatMinimizedState(presentation.floatingChatMinimized)
						setPalProfileOpen(presentation.palProfileOpen)
						setComputerProfileOpen(presentation.computerProfileOpen)
						setJobsOpen(presentation.jobsOpen)
						setPanelTab(presentation.panelTab)
						follow.current = presentation.follow
						requestAnimationFrame(() => {
							if (generation === navigation.current && transcript.current)
								transcript.current.scrollTop = presentation.scrollTop
						})
					} else follow.current = true
					if (context.current.focused && !context.current.frozen) input.current?.focus()
				} catch (failure) {
					if (generation === navigation.current) throw failure
				} finally {
					if (snapshotRead.current === read) snapshotRead.current = null
					if (openingHistory.current === generation) openingHistory.current = null
				}
			})()
			const current = { generation, promise: pending }
			openFlights.current.set(view.id, current)
			const settled = () => {
				if (openFlights.current.get(view.id) === current) openFlights.current.delete(view.id)
			}
			void pending.then(settled, settled)
			return pending
		},
		[abandonTabRestore, api, onAction, windowId, savedSettings.refresh, attached.reload],
	)
	useEffect(() => {
		let current = true
		void tabRestoreAttempt
		setProjectsLoaded(false)
		void api
			.projects()
			.then((items) => {
				if (!current) return
				setProjects(items)
				setProjectsLoaded(true)
				setProjectId((previous) => previous || items.find((item) => !item.palId)?.id || '')
			})
			.catch((failure) => {
				if (!current) return
				setError(errorText(failure))
				const target = context.current.group.activeTabId
				if (target) onLoadFailure(target, failure)
			})
		return () => {
			current = false
		}
	}, [api, tabRestoreAttempt, onLoadFailure])
	useEffect(() => {
		let current = true
		void tabRestoreAttempt
		const readable = projects.filter((item) => item.trusted && item.status === 'ready')
		void Promise.allSettled(readable.map((item) => api.conversations(item.id))).then((results) => {
			if (!current) return
			catalogueOwner.current = { projects, tabsKey: catalogueTabsKey }
			const rows = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
			setConversations((all) => [
				...rows,
				...all.filter((item) => !rows.some((row) => row.id === item.id)),
			])
			setCatalogueReady(true)
		})
		return () => {
			current = false
		}
	}, [api, projects, catalogueTabsKey, tabRestoreAttempt])
	useEffect(() => {
		void metadataEpoch
		setOpenTabIds([...group.tabs])
		const target = group.activeTabId || ''
		if (!target) {
			activation.current = null
			if (sessionId && !group.tabs.includes(sessionId)) {
				navigation.current++
				setSessionId('')
				setConversationSelection(null)
			}
			setTabsRestored(true)
			setRestoringTabs(false)
			return
		}
		if (
			!projectsLoaded ||
			!catalogueReady ||
			catalogueOwner.current?.projects !== projects ||
			catalogueOwner.current.tabsKey !== catalogueTabsKey ||
			activation.current === target
		)
			return
		const view = conversations.find((item) => item.id === target)
		if (!view) {
			if (loading || operations.current.size > 0) return
			if (missingActivation.current === target) return
			if (projects.every((item) => item.status === 'ready' || item.status === 'error')) {
				missingActivation.current = target
				setRestoringTabs(true)
				const failure = new Error(
					'This conversation could not be loaded. Reconnect its project or retry.',
				)
				setError(failure.message)
				onLoadFailure(target, failure)
			}
			return
		}
		missingActivation.current = null
		activation.current = target
		if (
			sessionId === target &&
			hydratedSession.current === target &&
			openingHistory.current === null
		) {
			setTabsRestored(true)
			setRestoringTabs(false)
			return
		}
		setRestoringTabs(true)
		void openConversation(view, 'projects', true)
			.then(() => {
				if (activation.current !== target) return
				setTabsRestored(true)
				setRestoringTabs(false)
			})
			.catch((failure) => {
				if (activation.current !== target) return
				setError(errorText(failure))
				onLoadFailure(target, failure)
			})
	}, [
		group.activeTabId,
		group.tabs,
		catalogueReady,
		catalogueTabsKey,
		loading,
		projectsLoaded,
		conversations,
		projects,
		metadataEpoch,
		openConversation,
		sessionId,
		onLoadFailure,
	])
	useEffect(() => {
		void metadataEpoch
		if (
			!group.activeTabId ||
			warmSessions.current.mutating(sessionId) ||
			sessionId !== group.activeTabId ||
			hydratedSession.current !== sessionId ||
			restoringTabs ||
			!providerReady ||
			savedSettings.loading ||
			savedSettings.error ||
			!attached.loaded ||
			project?.status !== 'ready'
		)
			return
		if (!warmSessions.current.read(sessionId, projectId))
			warmSessions.current.remember(warmSessions.current.ticket(sessionId, projectId), {
				providers,
				harness: harnessView,
				modelSettings: new Map(),
			})
		onReady(group.id, sessionId)
	}, [
		group.id,
		group.activeTabId,
		sessionId,
		restoringTabs,
		providerReady,
		savedSettings.loading,
		savedSettings.error,
		attached.loaded,
		project?.status,
		projectId,
		metadataEpoch,
		providers,
		harnessView,
		onReady,
	])
	useEffect(
		() =>
			registerController(group.id, {
				prepare: async () => {
					context.current.frozen = true
					setLocalFrozen(true)
					setCommandOpen(false)
					setCreatingPal(false)
					setEditingPal(undefined)
					writePresentation.current()
					paneRoot.current?.querySelector<HTMLElement>(':focus')?.blur()
					await Promise.all([...operations.current])
					await inputQueue.current?.flush()
					await facade.current?.flush()
					flushSync(() => setLocalFrozen(true))
					writePresentation.current()
				},
				resume: () => {
					setLocalFrozen(false)
				},
			}),
		[group.id, registerController],
	)

	const upsertPal = (value: PalView) =>
		setPals((all) =>
			all.some((item) => item.id === value.id)
				? all.map((item) => (item.id === value.id ? value : item))
				: [...all, value],
		)
	const showPalOnboarding = () => {
		abandonTabRestore()
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
		abandonTabRestore()
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
			let latest = [...opened.conversations].sort(compareConversationRecency)[0]
			if (!latest) {
				// Claim an owned conversation without starting inference or its computer.
				const created = await api.newConversation(opened.project.id)
				latest = created
				setConversations((all) => [created, ...all.filter((item) => item.id !== created.id)])
				setThreads((all) => ({ ...all, [created.id]: emptyThread() }))
				if (generation !== navigation.current) return
			}
			await openConversation(latest)
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
		api,
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
	const palCanChat = !pal || !pal.paused
	const computerCapture = pal ? palScreens[pal.id] : undefined
	const currentScreen =
		palComputer?.status === 'ready' && computerCapture?.generation === palComputer.generation
			? (computerCapture?.screen ?? null)
			: null
	const palWorkspace = !!pal && !palsPage && railSection === null
	const computerTabOpen = palWorkspace && palScreen?.palId === pal.id
	const computerPage = computerTabOpen && palScreen?.activeTab === 'computer'
	useEffect(() => {
		if (focused)
			onShellState({
				page:
					railSection === 'plugins'
						? 'plugins'
						: palsPage
							? 'pals'
							: computerPage
								? 'computer'
								: 'chat',
			})
	}, [focused, railSection, palsPage, computerPage, onShellState])
	const savePresentation = useCallback(() => {
		if (!sessionId || !context.current.group.tabs.includes(sessionId)) return
		writeWorkspacePresentation(localStorage, sessionId, {
			palScreen,
			computerChat,
			floatingChatMinimized,
			palProfileOpen,
			computerProfileOpen,
			jobsOpen,
			panelTab,
			follow: follow.current,
			scrollTop: transcript.current?.scrollTop ?? 0,
		})
	}, [
		sessionId,
		palScreen,
		computerChat,
		floatingChatMinimized,
		palProfileOpen,
		computerProfileOpen,
		jobsOpen,
		panelTab,
	])
	writePresentation.current = savePresentation
	useEffect(() => {
		if (frozen || openingHistory.current !== null) return
		try {
			savePresentation()
		} catch (failure) {
			setError(errorText(failure))
		}
	}, [frozen, savePresentation])
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
	}, [
		computerPage,
		livePalId,
		liveStatus,
		liveGeneration,
		streamRefresh,
		invalidateComputerInput,
		api,
	])
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
		visible: computerPage && focused && !frozen,
	}
	const keyboardOwners = useRef(new ComputerKeyboardOwners())
	const inputQueue = useRef<ComputerInputQueue | null>(null)
	if (!inputQueue.current)
		inputQueue.current = new ComputerInputQueue(async (action, owner) => {
			if (action.type === 'release_keys') {
				keyboardOwners.current.assertRelease(action.keyboardId, owner)
				if (!api.palComputerInput) throw new ComputerInputRetiredError()
				// Focus loss retires new input, but cleanup still targets only its captured
				// allocation/lifetime. Main, runtime and guest keep their authority fences.
				await api.palComputerInput(owner.id, owner.generation, action)
				return
			}
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
				!paneRoot.current?.contains(document.activeElement) ||
				!context.current.focused ||
				context.current.frozen ||
				!computerSurfaceOwnsFocus(document.activeElement) ||
				!api.palComputerInput
			)
				throw new ComputerInputRetiredError()
			await api.palComputerInput(owner.id, owner.generation, action)
		})
	const computerInputQueue = inputQueue.current
	const releaseComputerKeyboard = async (keyboardId: string): Promise<void> => {
		const owner = keyboardOwners.current.owner(keyboardId)
		if (!owner) return
		try {
			await computerInputQueue.enqueue({ type: 'release_keys', keyboardId }, owner)
		} finally {
			keyboardOwners.current.retire(keyboardId, owner)
		}
	}
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
		if (action.type === 'release_keys') return releaseComputerKeyboard(action.keyboardId)
		const owner = { ...computerOwner.current }
		if (
			!document.hasFocus() ||
			!context.current.focused ||
			context.current.frozen ||
			!paneRoot.current?.contains(document.activeElement) ||
			!computerSurfaceOwnsFocus(document.activeElement)
		)
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
		const captured = {
			id: owner.id,
			generation: owner.generation,
			navigation: owner.navigation,
			viewEpoch: computerInputViewEpoch.current,
		}
		try {
			keyboardOwners.current.capture(action, captured)
		} catch (error) {
			return Promise.reject(error)
		}
		const sequence = ++inputSequence.current
		setInputBusy(true)
		const operation = computerInputQueue.enqueue(action, captured)
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
							: project?.status !== 'ready'
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
							? 'Start your Pal’s local computer to use apps and tools.'
							: undefined),
				},
				hostComputer: humanComputer,
				activity: palToolActivity(thread)
					.reverse()
					.map(({ id, tool }) => ({
						id,
						title: tool.title,
						status:
							tool.status === 'pending' && thread.activeToolIds.includes(id)
								? 'working'
								: undefined,
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
				onActivity: () => {
					setPanelTab('jobs')
					setJobsOpen(true)
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
				abandonTabRestore()
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
		abandonTabRestore()
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
								permissionMode: item.permissionMode ?? (pal ? 'auto' : 'prompt'),
							},
						})
				}
			} finally {
				editingQueue.current.delete(target)
				setQueueEditing((all) => ({ ...all, [target]: false }))
				if (activeSession.current === target) input.current?.focus()
			}
		},
		[sessionId, attached.reload, savedSettings.get, savedSettings.save, api, pal],
	)
	const send = async () => {
		if (context.current.frozen) return
		if (thread.retry || thread.retryNotice || thread.reason === 'paused')
			throw new Error(
				thread.retryNotice ??
					'Retry the paused turn before sending a new message. Your draft is retained.',
			)
		if (
			loading ||
			restoringTabs ||
			(!draft.trim() && attached.get(draftOwner).length === 0) ||
			!project?.trusted ||
			!palCanChat ||
			project.status !== 'ready' ||
			!choice.provider ||
			!providerReady ||
			savedSettings.loading ||
			harnessBusy ||
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
			if (
				!context.current.focused ||
				context.current.frozen ||
				event.isComposing ||
				event.keyCode === 229
			)
				return
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
		api,
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
					void act(() => selectProject(item.id))
					if (context.current.focused && !context.current.frozen) input.current?.focus()
				},
			})),
	]
	const palTabs: ConversationPalWorkspace | undefined =
		palWorkspace && pal && sessionId
			? {
					conversationId: sessionId,
					idPrefix: `${windowId}-${group.id}`,
					palName: pal.name,
					paused: pal.paused,
					busy: palBusy || controlBusy || palsSaving,
					activeTab: computerPage ? 'computer' : 'chat',
					computerTabOpen,
					profileOpen: computerPage ? computerProfileOpen : palProfileOpen,
					split: computerPage && computerChat === 'split',
					chatOpen: computerChat !== 'hidden',
					floating: computerChat === 'floating',
					onRename: () => showPalEditor(pal),
					onPause: palContextProps?.onPause,
					onReboot:
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
							: undefined,
					onOpenChat: showPalChat,
					onToggleProfile: () => {
						if (computerPage) setComputerProfileOpen((value) => !value)
						else setPalProfileOpen((value) => !value)
					},
					onOpenComputer: () => {
						openPalScreen(pal)
						setFloatingChatMinimized(false)
					},
					onCloseComputer: () => {
						invalidateComputerInput()
						setPalScreen(undefined)
						requestAnimationFrame(() =>
							paneRoot.current
								?.querySelector<HTMLElement>('[data-pal-chat-tab]')
								?.focus({ preventScroll: true }),
						)
					},
					onToggleChat: () => {
						setComputerChat((value) => (value === 'hidden' ? 'split' : 'hidden'))
						setFloatingChatMinimized(false)
					},
					onToggleFloating: () => {
						setComputerChat((value) => (value === 'floating' ? 'split' : 'floating'))
						setFloatingChatMinimized(false)
					},
				}
			: undefined
	const groupTabs = (
		<ConversationTabs
			tabs={normalTabs}
			active={group.activeTabId || sessionId}
			busy={loading || harnessBusy || frozen}
			palNames={Object.fromEntries(pals.map((item) => [item.id, item.name]))}
			palWorkspace={palTabs}
			running={(id) => threads[id]?.running ?? false}
			onNew={() => void act(newConversation)}
			onSelect={(view) => void act(() => openConversation(view))}
			windowId={windowId}
			groupId={group.id}
			onDetach={(view, bounds) => onDetach(group.id, view.id, bounds)}
			onSplit={
				group.tabs.length > 1 ? (view, position) => onSplit(group.id, view.id, position) : undefined
			}
			onClose={(view) =>
				void onAction({ kind: 'close', groupId: group.id, tabId: view.id }).catch((failure) =>
					setError(errorText(failure)),
				)
			}
		/>
	)
	return (
		<>
			{focused &&
				shell &&
				createPortal(
					<>
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
								abandonTabRestore()
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
							conversations={conversations.filter(
								(view) =>
									view.palId ||
									view.title !== 'New conversation' ||
									threads[view.id]?.messages.length,
							)}
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
							onProject={(id) => void act(() => selectProject(id))}
							onConversation={(view, collection) =>
								void act(() => openConversation(view, collection))
							}
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
					</>,
					shell,
				)}
			<main
				ref={paneRoot}
				inert={frozen}
				data-pane-id={group.id}
				data-moving={frozen}
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
				<WorkspacePageHeader
					className="topbar workspace-conversation-header"
					aria-label="Conversation workspace"
				>
					{normalTabs.length > 0 ? (
						groupTabs
					) : (
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
					)}
					{!pal && sessionId && thread.messages.length > 0 && !externalHarness && (
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
				{computerPage && pal && palContextProps && (
					<PalComputerView
						id={computerIds.computerPanel}
						aria-labelledby={computerIds.computerTab}
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
						inputEnabled={focused && !frozen}
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
						onReleaseKeyboard={api.palComputerInput ? releaseComputerKeyboard : undefined}
						onKeyboardFocus={onComputerFocus}
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

				{(error || project?.error || savedSettings.error) && (
					<div className="connection-error">
						<ChatErrorBanner
							message={savedSettings.error || error || project?.error || ''}
							onRetry={
								restoringTabs
									? () =>
											void act(async () => {
												const generation = navigation.current
												if (project?.status === 'error')
													updateProject(await api.reconnectProject(project.id))
												if (generation === navigation.current) {
													activation.current = null
													missingActivation.current = null
													setCatalogueReady(false)
													setError('')
													setTabRestoreAttempt((attempt) => attempt + 1)
												}
											})
									: project?.status === 'error'
										? () =>
												void act(async () => updateProject(await api.reconnectProject(project.id)))
										: savedSettings.error ||
												(project?.trusted &&
													(!providerReady || (!pal && api.harnesses && !harnessView)))
											? () => void act(retryConversationSetup)
											: undefined
							}
							retryLabel={project?.status === 'error' ? 'Reconnect' : 'Retry setup'}
							onDismiss={
								!restoringTabs && project?.status !== 'error' && !savedSettings.error
									? () => setError('')
									: undefined
							}
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
						id={palWorkspace ? computerIds.chatPanel : undefined}
						role={palWorkspace ? 'tabpanel' : undefined}
						aria-labelledby={palWorkspace ? computerIds.chatTab : undefined}
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
									{thread.partial && (
										<p className="notice">
											Showing the latest part of this conversation. The full record remains on this
											device.
										</p>
									)}
									{pal ? (
										<PalChatTranscript
											key={sessionId}
											thread={thread}
											name={pal.name}
											intro={conversation?.palGreeting}
										/>
									) : (
										<>
											<Transcript key={sessionId || 'blank'} thread={thread} />
											<ChangedFilesCard
												tools={thread.tools}
												onOpen={() => {
													setPanelTab('changes')
													setJobsOpen(true)
												}}
											/>
										</>
									)}
									<TasksProgress
										thread={thread}
										onOpen={() => {
											setPanelTab('jobs')
											setJobsOpen(true)
										}}
									/>
									{thread.error && (
										<p className="inline-error" role="alert">
											{thread.error}
										</p>
									)}
									<TurnRecovery
										retry={thread.retry}
										notice={thread.retryNotice}
										disabled={thread.running || loading || frozen || project.status !== 'ready'}
										onRetry={
											api.retryTurn && thread.retry
												? () => {
														const retry = thread.retry
														const retryTurn = api.retryTurn
														if (retry && retryTurn)
															void act(() => retryTurn(sessionId, retry.turnId, retry.checkpointId))
													}
												: undefined
										}
									/>
								</div>
							</div>
							<Composer
								variant={pal ? 'pal' : 'default'}
								pluginsSupported={!pal}
								toolsAvailable={palCanWork}
								draftDisabled={
									loading ||
									restoringTabs ||
									frozen ||
									Boolean(group.activeTabId && group.activeTabId !== sessionId)
								}
								inputRef={input}
								permissions={thread.permissions}
								onApproval={(permission, approved) =>
									void act(() => api.approve(permission.sessionId, permission.id, approved))
								}
								projectName={project.name}
								projectId={project.id}
								sessionId={sessionId || undefined}
								projectPath={project.path}
								harnessView={harnessView}
								permissionEngine={permissionEngine}
								harnessBusy={harnessBusy || loading || restoringTabs || frozen}
								onHarnessChange={(engine) => void act(() => selectHarness(engine))}
								attachmentsSupported={!externalHarness}
								reviewModes={permissionEngine === 'claude-code' ? ['prompt', 'plan'] : undefined}
								permissionScope={draftOwner}
								onLeaveProject={() => void act(leaveProject)}
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
									!savedSettings.loading &&
									!harnessBusy &&
									!loading &&
									!restoringTabs
								}
								connected={
									project.status === 'ready' &&
									!thread.retry &&
									!thread.retryNotice &&
									thread.reason !== 'paused' &&
									palCanChat &&
									providerReady &&
									project.trusted &&
									!savedSettings.loading &&
									!harnessBusy &&
									!loading &&
									!restoringTabs
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
					aria-label={panelTab === 'jobs' ? 'Activity' : 'Changes'}
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
								Activity
							</Button>
						</div>
						<Button
							type="button"
							variant="ghost-muted"
							size="icon-sm"
							className="icon-button"
							aria-label={panelTab === 'jobs' ? 'Close activity' : 'Close changes'}
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
							<ConversationTasks thread={thread} />
							{pal && <PalActivity thread={thread} />}
							<h3 className="text-sm font-medium">Background shells</h3>
							{jobsError ? (
								<p role="alert" className="jobs-error">
									{jobsError}
								</p>
							) : jobsLoading ? (
								<p className="quiet">Loading background work…</p>
							) : visibleJobs.length === 0 ? (
								!pal && <p className="quiet">No background shells in this conversation.</p>
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
		</>
	)
}
