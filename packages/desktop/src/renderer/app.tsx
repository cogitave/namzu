import { ArrowDown, MessageSquare, Minus } from 'lucide-react'
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
	type BackgroundWorkStatus,
	freshBackgroundWorkStatus,
} from '../shared/background-work-protocol.js'
import { resolveComposerSendOptions } from '../shared/composer-send-options.js'
import { duplicatePalNameMessage, isDuplicatePalName } from '../shared/pal-name.js'
import {
	type ThreadState,
	applyEvent,
	emptyThread,
	queueParked,
	restoreMessages,
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
	PalCreateInput,
	PalScreenView,
	PalView,
	ProjectGitView,
	ProjectView,
	ProviderView,
} from '../shared/protocol.js'
import { usableProviders } from '../shared/provider-connections.js'
import type { DataFolderKind, SettingsSection } from '../shared/settings-protocol.js'
import { PROMPT_NOT_PASSED, TERMINAL_ENGINE_LABELS } from '../shared/terminal-tabs.js'
import type { UpdateState } from '../shared/update-protocol.js'
import {
	ADD_PROJECT_LABEL,
	AddProjectMenu,
	START_FROM_SCRATCH_LABEL,
	USE_EXISTING_FOLDER_LABEL,
} from './add-project-menu.js'
import { ArchivedConversationsDialog } from './archived-conversations-dialog.js'
import { applyCachedAttachmentPreviewEviction } from './attachment-preview-events.js'
import { ChangesPanel } from './changes-panel.js'
import { type ChangeTotals, changeTotals } from './changes-totals.js'
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
import { ConfirmRemovalDialog } from './confirm-removal-dialog.js'
import { ConversationActionsMenu } from './conversation-actions-menu.js'
import {
	type ConversationActionId,
	type ConversationActionInput,
	conversationActionGroups,
	conversationShortcut,
	conversationSources,
	lastReplyText,
} from './conversation-actions.js'
import { ConversationDetailsPopover, type DetailsWork } from './conversation-details-popover.js'
import { compareConversationOrder, compareConversationRecency } from './conversation-order.js'
import {
	type ConversationPalWorkspace,
	type ConversationTabActions,
	ConversationTabs,
} from './conversation-tabs.js'
import { ConversationTasks } from './conversation-tasks.js'
import { copyPlainText } from './copy-button.js'
import { signInHelpFor } from './engine-setup.js'
import { FilePanelBody } from './file-panel/file-panel.js'
import {
	MIN_PANEL_WIDTH,
	type PanelTab,
	type PanelTabsState,
	activatePanelTab,
	activeFilePath,
	activityTab,
	browsePanelTabs,
	changesTab,
	clampPanelWidth,
	closePanelTab,
	emptyPanelTabs,
	ensurePanelTab,
	openFileTab,
	readPanelTabs,
	readPanelWidth,
	shownTab,
	writePanelTabs,
	writePanelWidth,
} from './file-panel/file-tabs.js'
import { useEditors } from './file-panel/open-in.js'
import { PanelResizeHandle, PanelTabStrip, type PanelView } from './file-panel/panel-tabs.js'
import { ProjectFilesContext } from './file-panel/project-files.js'
import { createLinkCache } from './file-panel/project-refs.js'
import { FolderAccessDialog } from './folder-access-dialog.js'
import {
	describeBlockedRetry,
	describeEngineFailure,
	describeFailure,
	lostConnectionText,
	providerName,
	withUnknownUsage,
} from './friendly-errors.js'
import { type EngineSurface, type EngineSurfaceControl, engineLabel } from './harness-picker.js'
import {
	ArchiveIcon,
	ArrowUpIcon,
	FolderIcon,
	MoreHorizontalIcon,
	PanelLeftIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
	SplitDownIcon,
	SplitRightIcon,
	SquareIcon,
	SquarePenIcon,
	TerminalIcon,
	XIcon,
} from './icons.js'
import { JobRow } from './job-row.js'
import { LocalSpeechReadAloud } from './local-speech-settings.js'
import { MessageActions } from './message-actions.js'
import {
	invalidateModelCatalogueDisplayCache,
	modelCatalogueDisplayCacheForApi,
} from './model-catalogue-display-cache.js'
import {
	effortToSend,
	isUnchosen,
	resolveComposerModelChoice,
	staleEffort,
} from './model-choice.js'
import { NavigationRail } from './navigation-rail.js'
import {
	type NewTabActionId,
	type NewTabPlacement,
	terminalUnavailableReason,
} from './new-tab-menu.js'
import { normalConversationProject } from './normal-conversation.js'
import { notify } from './notify.js'
import { PalChatTranscript } from './pal-chat-transcript.js'
import { PalCommunicationDialog, type PalSettingsTab } from './pal-communication-dialog.js'
import { presentComputerNotice } from './pal-computer-notice.js'
import { PalComputerView } from './pal-computer-view.js'
import { PalContextCard, type PalContextProps } from './pal-context.js'
import { palDeletionCopy } from './pal-deletion-copy.js'
import { PalStartContext, type PalStartControls, palMessageSends } from './pal-message-receipts.js'
import {
	PalCatalogueActivity,
	latestPalConversation,
	mergeConversationCatalogues,
	warmPalConversation,
} from './pal-navigation.js'
import { palRecentActivity } from './pal-recent-activity.js'
import { palStartCard, palWaitingLine } from './pal-start-model.js'
import { unreadAfterOpen, unreadAfterSends } from './pal-unread.js'
import { PalCustomizeDialog, type PalOpening, PalSidebarSection, PalsPage } from './pals-page.js'
import { PluginsPage, PluginsSidebar } from './plugins-page.js'
import {
	EMPTY_CONVERSATION_TITLE,
	emptyProjectConversation,
	reusableProjectDraft,
} from './project-draft-reuse.js'
import {
	createdProjectNotice,
	homeStarters,
	newProjectFailure,
	projectHomeHeading,
} from './project-home.js'
import { projectStage } from './project-stage.js'
import { ProjectConnecting, ProjectFolderMissing, ProjectOpenError } from './project-views.js'
import { ProviderNameContext } from './provider-name-context.js'
import { RenameConversationDialog } from './rename-conversation-dialog.js'
import { RestoreSkeleton } from './restore-skeleton.js'
import { retryableReply } from './retry-reply.js'
import { projectRemovalCopy, removalNotice, settingsRoute } from './settings-model.js'
import { SettingsPage, SettingsSidebar } from './settings-page.js'
import { type ConversationCollection, Sidebar } from './sidebar.js'
import { launchSeed, restoreDecision, settleLaunchSeed } from './startup-restore.js'
import { createSubmitGuard } from './submit-guard.js'
import { type TabChord, movedTabIndex, selectedTabIndex, tabChord } from './tab-keys.js'
import { TerminalPane } from './terminal-pane.js'
import { openTerminalFind, terminalApi, terminalSessions } from './terminal-registry.js'
import { engineTerminalRequest, shellTerminalRequest } from './terminal-request.js'
import type { ThreadRowActions } from './thread-card.js'
import { PaneToasts } from './toast.js'
import { Transcript } from './transcript.js'
import { TurnRecovery } from './turn-recovery.js'
import { Button } from './ui/button.js'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty.js'
import { UndoDialog } from './undo-dialog.js'
import { undoNotice } from './undo-model.js'
import { useAttachments } from './use-attachments.js'
import { useDesktopInfo, useDesktopSettings, useUpdateInfo } from './use-desktop-settings.js'
import { useDraftSettings } from './use-draft-settings.js'
import { useEngineUpdates } from './use-engine-updates.js'
import { useLocalSpeech } from './use-local-speech.js'
import { usePalOperatorMessages } from './use-pal-operator-messages.js'
import { usePalStarts } from './use-pal-starts.js'
import { useTranscriptScroll } from './use-transcript-scroll.js'
import { useUndoKept } from './use-undo-kept.js'
import { WindowTitlebar } from './window-titlebar.js'
import {
	WorkspaceBreadcrumb,
	WorkspaceBreadcrumbItem,
	WorkspaceBreadcrumbSeparator,
	WorkspaceBreadcrumbText,
} from './workspace-breadcrumb.js'
import { WorkspacePageHeader } from './workspace-page-header.js'
import { createWorkspacePaneApi } from './workspace-pane-api.js'
import type { WorkspacePaneProps } from './workspace-pane-types.js'
import {
	type WorkDisclosureChoices,
	chooseWorkDisclosure,
	readWorkspacePresentation,
	writeWorkspacePresentation,
} from './workspace-presentation.js'
import { WorkspaceSessionCache } from './workspace-session-cache.js'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const conversationIsGone = (error: unknown) =>
	/does not belong to this project/.test(errorText(error))
function omitRecords<T>(records: Record<string, T>, ids: ReadonlySet<string>): Record<string, T> {
	return Object.fromEntries(Object.entries(records).filter(([id]) => !ids.has(id)))
}
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
const NO_UPDATER: UpdateState = { status: 'disabled' }
/** How many of the newest conversations the command palette lists under "Recent". */
const RECENT_PALETTE_CONVERSATIONS = 5
/** How long the Undo toast after archiving stays: long enough to read where the conversation went. */
const ARCHIVE_UNDO_MS = 20_000
export function App({
	group,
	terminals: terminalGroup,
	windowId,
	focused,
	shell,
	frozen: externalFrozen,
	appearance,
	startAtHome = false,
	update,
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
	const removedPals = useRef(new Set<string>())
	const removedProjects = useRef(new Set<string>())
	const removedConversations = useRef(new Set<string>())
	const [removedCatalogue, setRemovedCatalogue] = useState(() => ({
		pals: new Set<string>(),
		projects: new Set<string>(),
		conversations: new Set<string>(),
	}))
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
	const lostProjects = useRef(new Set<string>())
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
	const [workDisclosureView, setWorkDisclosureView] = useState<{
		sessionId: string
		choices: WorkDisclosureChoices
	}>({ sessionId: '', choices: {} })
	const workDisclosureViewRef = useRef(workDisclosureView)
	const pendingPresentationScroll = useRef<{
		generation: number
		sessionId: string
		scrollTop: number
		follow: boolean
	} | null>(null)

	const [palRecords, setPals] = useState<PalView[]>([])
	const pals = useMemo(
		() => palRecords.filter((item) => !removedCatalogue.pals.has(item.id)),
		[palRecords, removedCatalogue],
	)
	// Names for an approval that only carries a Pal's ID.
	const palNames = useMemo(() => new Map(pals.map((item) => [item.id, item.name])), [pals])
	const [palsLoading, setPalsLoading] = useState(true)
	const [palsError, setPalsError] = useState('')
	const [palsLoadFailed, setPalsLoadFailed] = useState(false)
	const [palsSaving, setPalsSaving] = useState(false)
	const savingPal = useRef(createSubmitGuard())
	const openingRun = useRef(0)
	const [palOpening, setPalOpening] = useState<PalOpening>()
	const [palsPage, setPalsPage] = useState(false)
	const [creatingPal, setCreatingPal] = useState(false)
	const [editingPal, setEditingPal] = useState<PalView>()
	const [deletingPal, setDeletingPal] = useState<PalView>()
	// The in-app folder consent. `broad` is main's one-time proof for a drive, home or system folder.
	const [folderAccess, setFolderAccess] = useState<{
		projectId: string
		broad?: NonNullable<ProjectView['broadFolder']>
		risky?: NonNullable<ProjectView['riskySettings']>
		/** A picked folder that is not in the app yet; only a confirmed trust adds it. */
		pending?: { name: string; path: string }
	}>()
	const [removingConversation, setRemovingConversation] = useState<ConversationView>()
	const [removingProject, setRemovingProject] = useState<ProjectView>()
	const [renamingProject, setRenamingProject] = useState<ProjectView>()
	const projectRemovalTrigger = useRef<HTMLElement | null>(null)
	const projectRenameTrigger = useRef<HTMLElement | null>(null)
	const removalTrigger = useRef<HTMLElement | null>(null)
	const [communicationOwner, setCommunicationOwner] = useState<{
		palId: string
		sessionId: string
		tab?: PalSettingsTab
	}>()
	// A Pal whose messages the person asked to see; shown once its conversation is the open one.
	const [pendingPalInbox, setPendingPalInbox] = useState<string>()
	const communicationTrigger = useRef<HTMLButtonElement | null>(null)
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
	// Seed data from the pre-paint snapshot, for the panes of the launch commit only; the
	// asynchronous reads below replace all of it.
	const [seed] = useState(() => launchSeed())
	useEffect(() => settleLaunchSeed(), [])
	const [projectRecords, setProjects] = useState<ProjectView[]>(() => seed?.projects ?? [])
	const projects = useMemo(
		() =>
			projectRecords.filter(
				(item) =>
					!removedCatalogue.projects.has(item.id) &&
					(!item.palId || !removedCatalogue.pals.has(item.palId)),
			),
		[projectRecords, removedCatalogue],
	)
	const [projectId, setProjectId] = useState('')
	const [conversationRecords, setConversations] = useState<ConversationView[]>([])
	// Saved views of the launch tabs. They are never listed: a row is actionable only once its
	// folder is connected. They tell the restore which folder a tab belongs to before the
	// authoritative listing arrives.
	const [savedViews] = useState(() => seed?.conversations ?? [])
	const conversations = useMemo(
		() =>
			conversationRecords.filter(
				(item) =>
					!removedCatalogue.conversations.has(item.id) &&
					!removedCatalogue.projects.has(item.projectId) &&
					(!item.palId || !removedCatalogue.pals.has(item.palId)),
			),
		[conversationRecords, removedCatalogue],
	)
	const catalogueRows = useRef({ projects, conversations })
	catalogueRows.current = { projects, conversations }
	const palCatalogueActivity = useRef(new PalCatalogueActivity())
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
	// The engine whose process the pending choice is starting; the trigger says so while it waits.
	const [startingEngine, setStartingEngine] = useState<HarnessView['selected']>()
	const harnessChoicePending = useRef(false)
	// A pane that is not a tab (a landing or a draft) while an engine choice settles on it: tab
	// restore must not take the pane away to open another tab or clear it.
	const paneHold = useRef('')
	// The untouched draft this window last opened for each project, so a project switch reuses it.
	const projectDrafts = useRef(new Map<string, string>())
	const harnessChoiceFailure = useRef<{
		sessionId: string
		message: string
	} | null>(null)
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
	// Display provenance is separate from write admission. A closed tab may show
	// its last loaded history while main refreshes it; it cannot reuse metadata.
	const loadedHistory = useRef(new Map<string, { projectId: string; connection: number }>())
	const [historyDisplay, setHistoryDisplay] = useState<{
		sessionId: string
		saved: boolean
		refreshing: boolean
		pending?: boolean
	} | null>(null)
	const threadsRef = useRef(threads)
	threadsRef.current = threads
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const draftsRef = useRef<Record<string, string>>({})
	const draftEditRevisions = useRef(new Map<string, number>())
	const draftAdmissions = useRef(
		new Map<
			string,
			{
				prompt: string
				editRevision: number
				restored: boolean
				started: boolean
			}
		>(),
	)
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
	const activeProjectId = useRef('')
	activeProjectId.current = projectId
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
		const activities = readable.map((item) =>
			item.palId ? palCatalogueActivity.current.ticket(item.palId) : undefined,
		)
		setCommandListing({ loading: true, notice: '' })
		void Promise.allSettled(readable.map((item) => api.conversations(item.id))).then((results) => {
			if (generation !== commandRead.current) return
			for (const [index, result] of results.entries()) {
				const palId = readable[index]?.palId
				const activity = activities[index]
				if (!palId || activity === undefined) continue
				if (result.status === 'fulfilled') palCatalogueActivity.current.confirm(palId, activity)
				else palCatalogueActivity.current.changed(palId)
			}
			const rows = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
			const refreshed = readable
				.filter((_item, index) => results[index]?.status === 'fulfilled')
				.map((item) => item.id)
			setConversations((previous) => mergeConversationCatalogues(previous, rows, refreshed))
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
	const [railSection, setRailSection] = useState<'spaces' | 'plugins' | 'settings' | null>(null)
	const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
	const [settingsFocus, setSettingsFocus] = useState<string>()
	/** Plugins and Settings replace the conversation with a page of their own. */
	const pageOpen = railSection === 'plugins' || railSection === 'settings'
	const settingsOpen = railSection === 'settings'
	const desktopSettings = useDesktopSettings(api, settingsOpen)
	const desktopInfo = useDesktopInfo(
		api,
		settingsOpen && (settingsSection === 'about' || settingsSection === 'speech'),
	)
	const updateInfo = useUpdateInfo(api, update?.state ?? NO_UPDATER, settingsOpen)
	const previousRailSection = useRef(railSection)
	useEffect(() => {
		const previous = previousRailSection.current
		previousRailSection.current = railSection
		if ((previous === 'plugins' || previous === 'settings') && railSection === null)
			input.current?.focus({ preventScroll: true })
	}, [railSection])
	const [jobsOpen, setJobsOpen] = useState(false)
	// Expanded, the panel takes the whole pane and the conversation is hidden; kept per pane.
	const [panelExpanded, setPanelExpanded] = useState(false)
	// One reply's receipts while the drawer shows just that reply; undefined shows everything.
	const [changesFilterState, setChangesFilterState] = useState<{
		sessionId: string
		ids: string[]
		focus?: { path: string }
	}>()
	// Tied to its conversation, so a switch never shows another conversation's receipt ids for a frame.
	const changesFilter =
		changesFilterState?.sessionId === sessionId ? changesFilterState.ids : undefined
	// The file a clicked card row names; a fresh object each click, so the same row can be chosen again.
	const changesFocus =
		changesFilterState?.sessionId === sessionId ? changesFilterState.focus : undefined
	const setChangesFilter = useCallback(
		(ids: string[] | undefined, path?: string) =>
			setChangesFilterState(ids && { sessionId, ids, focus: path ? { path } : undefined }),
		[sessionId],
	)
	// The drawer opens from the details popover, so closing it returns focus to the popover's icon.
	const detailsTrigger = useRef<HTMLButtonElement>(null)
	const [detailsPopoverOpen, setDetailsPopoverOpen] = useState(false)
	const [renamingConversation, setRenamingConversation] = useState<ConversationView>()
	const [undoingTurn, setUndoingTurn] = useState<{ sessionId: string; turnId: string }>()
	const [archivedOpen, setArchivedOpen] = useState(false)
	const renameTrigger = useRef<HTMLElement | null>(null)
	const announce = useCallback((text: string) => void notify(text), [])
	const [git, setGit] = useState<{ projectId: string; value: ProjectGitView | null }>()
	const closeDetails = useCallback(() => {
		setJobsOpen(false)
		detailsTrigger.current?.focus({ preventScroll: true })
	}, [])
	const [jobs, setJobs] = useState<JobView[]>([])
	const [backgroundWork, setBackgroundWork] = useState<Record<string, BackgroundWorkStatus>>({})
	const backgroundWorkVersions = useRef(new Map<string, number>())
	const [jobsSessionId, setJobsSessionId] = useState('')
	const refreshJobs = useRef<(() => Promise<void>) | undefined>(undefined)
	const [jobsError, setJobsError] = useState('')
	const [jobsLoading, setJobsLoading] = useState(false)
	const [error, setError] = useState('')
	// The conversation whose "Continue without this reply" failed, so the card also offers a copy.
	const [continueFailed, setContinueFailed] = useState<string>('')
	const [sending, setSending] = useState<Record<string, boolean>>({})
	const sendingRef = useRef(new Set<string>())
	const input = useRef<HTMLTextAreaElement>(null)
	const transcript = useRef<HTMLDivElement>(null)
	const follow = useRef(true)
	// Where the reader stopped is kept with the rest of the conversation's view, so a restart
	// reopens it there and not where it was when something else last changed.
	const keepScrollPosition = useCallback(() => {
		if (context.current.frozen || openingHistory.current !== null) return
		try {
			writePresentation.current()
		} catch (failure) {
			setError(errorText(failure))
		}
	}, [])
	const transcriptScroll = useTranscriptScroll(sessionId, transcript, follow, keepScrollPosition)
	const project = projects.find((item) => item.id === projectId)
	// A folder that failed to open gets its own stage, which already carries the error text.
	const stage = project ? projectStage(project) : undefined
	// Terminal tabs share this pane's strip. The conversation side never sees them.
	const terminalById = new Map((terminalGroup?.tabs ?? []).map((tab) => [tab.id, tab]))
	const stripTerminals = (terminalGroup?.order ?? []).flatMap((id) => {
		const tab = terminalById.get(id)
		return tab ? [tab] : []
	})
	const activeTerminal =
		!startAtHome && terminalGroup?.activeId ? terminalById.get(terminalGroup.activeId) : undefined
	const terminalBridge = terminalApi(window.namzu)
	const terminalReady = Boolean(
		terminalBridge &&
			window.namzu.openTerminal &&
			project?.trusted &&
			project.status === 'ready' &&
			!project.palId,
	)
	const terminalSessionsHere = terminalBridge ? terminalSessions(terminalBridge) : undefined
	const activeTabProject = projects.find(
		(item) =>
			item.id ===
			(
				conversations.find((row) => row.id === group.activeTabId) ??
				savedViews.find((row) => row.id === group.activeTabId)
			)?.projectId,
	)
	const restoreHold =
		restoreDecision({
			startupHome: startAtHome,
			activeTabId: group.activeTabId,
			restoring: restoringTabs,
			failed: Boolean(error),
			tabProject: activeTabProject,
		}) === 'restore'
	const openErrorStage = stage === 'error'
	const conversation = conversations.find((item) => item.id === sessionId)
	const speech = useLocalSpeech(api, sessionId || undefined)
	const historyPending = historyDisplay?.sessionId === sessionId && !!historyDisplay.pending
	const thread = historyPending ? emptyThread() : (threads[sessionId] ?? emptyThread())
	const pal = pals.find((item) => item.id === project?.palId)
	// A Pal row shows a marker from the moment the person messages it until they open it.
	const [unreadPals, setUnreadPals] = useState<ReadonlySet<string>>(() => new Set())
	const countedPalSends = useRef(new Set<string>())
	useEffect(() => {
		setUnreadPals((previous) =>
			unreadAfterSends(previous, countedPalSends.current, threads, pals, pal?.id),
		)
	}, [threads, pals, pal?.id])
	useEffect(() => {
		if (pal?.id) setUnreadPals((previous) => unreadAfterOpen(previous, pal.id))
	}, [pal?.id])
	const palStarts = usePalStarts(api, threads, pals, pal?.id)
	// Main keeps the markers, so a restart brings them back. `savedUnread` is what main holds now.
	const savedUnread = useRef<ReadonlySet<string> | undefined>(undefined)
	const openPalIdRef = useRef(pal?.id)
	openPalIdRef.current = pal?.id
	useEffect(() => {
		if (!api.palUnread) {
			savedUnread.current = new Set()
			return
		}
		let current = true
		void api
			.palUnread()
			.then((ids) => {
				if (!current) return
				savedUnread.current = new Set(ids)
				setUnreadPals((previous) => {
					const next = new Set(previous)
					for (const id of ids) if (id !== openPalIdRef.current) next.add(id)
					// Always a new set, so the sync below runs once even when nothing was added.
					return next
				})
			})
			.catch(() => {
				savedUnread.current = new Set()
				setUnreadPals((previous) => new Set(previous))
			})
		return () => {
			current = false
		}
	}, [api])
	useEffect(() => {
		const saved = savedUnread.current
		if (!saved || !api.setPalUnread) return
		const next = new Set(saved)
		for (const id of unreadPals) if (!saved.has(id)) next.add(id)
		for (const id of saved) if (!unreadPals.has(id)) next.delete(id)
		for (const id of next) if (!saved.has(id)) void api.setPalUnread(id, true).catch(() => {})
		for (const id of saved) if (!next.has(id)) void api.setPalUnread(id, false).catch(() => {})
		savedUnread.current = next
	}, [api, unreadPals])
	const palOperatorMessages = usePalOperatorMessages(
		api,
		sessionId,
		pal?.id,
		`${thread.turn}:${thread.running}`,
	)
	const palConversation = Boolean(project?.palId || conversation?.palId)
	const detailsOpen = jobsOpen && !palConversation
	// Files belong to a trusted, ready project the person opened; never a chat or a Pal's workspace.
	const filesEnabled = Boolean(
		project?.trusted &&
			project.status === 'ready' &&
			!project.isChat &&
			!project.palId &&
			!palConversation &&
			api.readProjectFile &&
			api.listProjectDirectory,
	)
	const [panelTabsState, setPanelTabsState] = useState<{
		sessionId: string
		tabs: PanelTabsState
	}>({ sessionId: '', tabs: emptyPanelTabs })
	// The tabs are remembered per conversation, so a switch loads that conversation's tabs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a conversation switch reloads them.
	useEffect(() => {
		setPanelTabsState((value) =>
			value.sessionId === sessionId
				? value
				: {
						sessionId,
						tabs: sessionId
							? readPanelTabs(
									localStorage,
									sessionId,
									// Before tabs, the panel remembered which of the two it showed.
									readWorkspacePresentation(localStorage, sessionId)?.panelTab === 'changes'
										? 'changes'
										: 'activity',
								)
							: emptyPanelTabs,
					},
		)
	}, [sessionId])
	const panelTabs = panelTabsState.sessionId === sessionId ? panelTabsState.tabs : emptyPanelTabs
	const updatePanelTabs = useCallback(
		(change: (state: PanelTabsState) => PanelTabsState) =>
			setPanelTabsState((value) => {
				const base = value.sessionId === sessionId ? value.tabs : emptyPanelTabs
				const tabs = change(base)
				if (sessionId && tabs !== base) writePanelTabs(localStorage, sessionId, tabs)
				return { sessionId, tabs }
			}),
		[sessionId],
	)
	// A conversation that cannot show files never lists file tabs, though it keeps them stored.
	const panelAllows = useCallback(
		(tab: PanelTab) => filesEnabled || tab.kind !== 'file',
		[filesEnabled],
	)
	const listedTabs = useMemo(
		() => panelTabs.tabs.filter(panelAllows),
		[panelTabs.tabs, panelAllows],
	)
	const shownPanelTab = shownTab(panelTabs, panelAllows)
	const panelView: PanelView =
		filesEnabled && panelTabs.browsing ? 'browse' : (shownPanelTab?.kind ?? 'empty')
	const activePath =
		panelView === 'file' ? activeFilePath({ ...panelTabs, active: shownPanelTab }) : undefined
	/** Makes sure Changes or Activity is a tab, and shows it. */
	const showPanelTab = useCallback(
		(tab: 'activity' | 'changes') =>
			updatePanelTabs((state) =>
				ensurePanelTab(state, tab === 'changes' ? changesTab : activityTab),
			),
		[updatePanelTabs],
	)
	const openProjectFile = useCallback(
		(path: string, line?: number) => {
			updatePanelTabs((state) => openFileTab(state, path, line))
			setJobsOpen(true)
		},
		[updatePanelTabs],
	)
	const editors = useEditors(api, filesEnabled)
	const linkCache = useMemo(
		() =>
			createLinkCache((id, refs) =>
				api.resolveProjectLinks ? api.resolveProjectLinks(id, refs) : Promise.resolve([]),
			),
		[api],
	)
	// Keyed on the id: any other change to the project must not make every reply look its links up again.
	const filesProjectId = project?.id
	const projectFiles = useMemo(
		() =>
			filesEnabled && filesProjectId && api.resolveProjectLinks
				? {
						resolve: (refs: readonly string[]) => linkCache.resolve(filesProjectId, refs),
						open: openProjectFile,
					}
				: null,
		[filesEnabled, filesProjectId, api, linkCache, openProjectFile],
	)
	// The working tree is read through the host, for a trusted, ready project the person opened.
	const workingTree = useMemo(
		() =>
			filesEnabled && filesProjectId && api.projectChanges && api.projectDiff
				? {
						projectId: filesProjectId,
						changes: () => api.projectChanges?.(filesProjectId) ?? Promise.resolve(null),
						diff: (path: string) =>
							api.projectDiff?.(filesProjectId, path) ?? Promise.reject(new Error('Unavailable.')),
					}
				: undefined,
		[filesEnabled, filesProjectId, api],
	)
	// The panel keeps the width a person dragged it to, per pane.
	const [panelWidth, setPanelWidth] = useState<number | undefined>(() =>
		readPanelWidth(localStorage, group.id),
	)
	const [panelResizing, setPanelResizing] = useState(false)
	const panelAside = useRef<HTMLElement>(null)
	const [panelPx, setPanelPx] = useState(0)
	useEffect(() => {
		const node = panelAside.current
		if (!node || typeof ResizeObserver === 'undefined') return
		const watch = new ResizeObserver(([entry]) => entry && setPanelPx(entry.contentRect.width))
		watch.observe(node)
		return () => watch.disconnect()
	}, [])
	useLayoutEffect(() => {
		const pending = pendingPresentationScroll.current
		if (
			!pending ||
			pending.sessionId !== sessionId ||
			pending.generation !== navigation.current ||
			historyPending ||
			(historyDisplay?.sessionId === sessionId && historyDisplay.saved) ||
			workDisclosureView.sessionId !== sessionId
		)
			return
		let second: number | undefined
		const apply = (complete: boolean) => {
			if (
				pendingPresentationScroll.current !== pending ||
				pending.generation !== navigation.current ||
				activeSession.current !== pending.sessionId
			)
				return
			const node = transcript.current
			if (!node) return
			node.scrollTop = pending.scrollTop
			follow.current = pending.follow
			if (complete) pendingPresentationScroll.current = null
		}
		// The transcript can mount a few frames after its history is ready (the page behind it is
		// still settling); wait for it, up to a second's worth of frames, instead of giving up.
		let first = 0
		const attempt = (left: number) => {
			first = requestAnimationFrame(() => {
				if (!transcript.current && left > 0) return attempt(left - 1)
				apply(false)
				second = requestAnimationFrame(() => apply(true))
			})
		}
		attempt(60)
		return () => {
			cancelAnimationFrame(first)
			if (second !== undefined) cancelAnimationFrame(second)
		}
	}, [
		sessionId,
		historyPending,
		historyDisplay?.sessionId,
		historyDisplay?.saved,
		workDisclosureView,
	])
	useLayoutEffect(() => {
		const node = transcript.current
		if (!node || !sessionId) return
		const retire = () => {
			const pending = pendingPresentationScroll.current
			if (pending?.sessionId === sessionId && activeSession.current === sessionId)
				pendingPresentationScroll.current = null
		}
		const onKey = (event: KeyboardEvent) => {
			if (
				!event.defaultPrevented &&
				!event.altKey &&
				!event.ctrlKey &&
				!event.metaKey &&
				['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
			)
				retire()
		}
		// A reader action on visible retained history supersedes its old saved offset.
		// Scroll events alone also come from layout and programmatic restoration.
		node.addEventListener('wheel', retire, { passive: true })
		node.addEventListener('touchmove', retire, { passive: true })
		node.addEventListener('keydown', onKey)
		return () => {
			node.removeEventListener('wheel', retire)
			node.removeEventListener('touchmove', retire)
			node.removeEventListener('keydown', onKey)
		}
	}, [sessionId])
	useEffect(() => {
		if (
			!focused ||
			communicationOwner?.palId !== pal?.id ||
			communicationOwner?.sessionId !== sessionId
		)
			setCommunicationOwner(undefined)
	}, [focused, pal?.id, sessionId, communicationOwner])
	useEffect(() => {
		if (!pendingPalInbox || !focused || loading || !pal || pal.id !== pendingPalInbox || !sessionId)
			return
		setPendingPalInbox(undefined)
		communicationTrigger.current = null
		setCommunicationOwner({ palId: pal.id, sessionId, tab: 'inbox' })
	}, [pendingPalInbox, focused, loading, pal, sessionId])
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
	const detailsActive = detailsPopoverOpen && !palConversation
	// Line totals compare whole files, so they are read only while someone is looking.
	const totals = useMemo<ChangeTotals>(() => {
		if (!detailsActive) return { added: 0, removed: 0, files: 0 }
		const receipts = []
		for (const tool of Object.values(thread.tools))
			if (tool.status === 'completed' && tool.view.kind === 'diff') receipts.push(tool.view)
		return changeTotals(receipts)
	}, [detailsActive, thread.tools])
	const sources = useMemo(
		() => (detailsActive ? conversationSources(thread.messages) : []),
		[detailsActive, thread.messages],
	)
	const providerReady = providerOwner === providerKey
	const activeProviders: ProviderView = providerReady
		? providers
		: { available: [], selected: null }
	const harnessView = harnessState?.owner === providerKey ? harnessState.view : undefined
	const permissionEngine = pal
		? 'namzu'
		: (harnessView?.selected ?? conversation?.harness ?? 'namzu')
	const externalHarness = permissionEngine !== 'namzu'
	const sessionWork = externalHarness
		? ({ state: 'unavailable' } as const)
		: freshBackgroundWorkStatus(backgroundWork[sessionId])
	const needsAttention = sessionWork.state === 'known' && sessionWork.needsAttention
	const detailsWork: DetailsWork = externalHarness
		? { state: 'unavailable' }
		: jobsSessionId === sessionId && !jobsLoading && !jobsError
			? {
					state: 'known',
					running: visibleJobs.filter((job) => job.status === 'running').length,
					needsAttention,
				}
			: sessionWork.state === 'known'
				? { state: 'known', running: sessionWork.runningCount, needsAttention }
				: jobsSessionId === sessionId && jobsError
					? { state: 'unavailable' }
					: { state: 'checking' }
	const gitProjectId =
		project && !palConversation && !project.isChat && project.trusted && project.status === 'ready'
			? project.id
			: undefined
	const turnRunning = thread.running
	const undoKept = useUndoKept(api.undoPreview, sessionId, thread.undo)
	// A settled turn may have written files; the open file and the tree read the disk again.
	const [filesRefresh, setFilesRefresh] = useState(0)
	const wasRunning = useRef(false)
	useEffect(() => {
		if (wasRunning.current && !turnRunning) setFilesRefresh((value) => value + 1)
		wasRunning.current = turnRunning
	}, [turnRunning])
	// Read when the popover opens, and again if a turn ends while it is open. The host caches briefly.
	useEffect(() => {
		void turnRunning
		if (!detailsPopoverOpen || !gitProjectId || !api.projectGit) return
		let current = true
		void api.projectGit(gitProjectId).then(
			(value) => {
				if (current) setGit({ projectId: gitProjectId, value })
			},
			() => {
				if (current) setGit({ projectId: gitProjectId, value: null })
			},
		)
		return () => {
			current = false
		}
	}, [detailsPopoverOpen, gitProjectId, turnRunning, api])
	const normalTabs = group.tabs.map(
		(id): ConversationView =>
			conversations.find((item) => item.id === id) ??
			// A folder that is gone lists nothing, but the saved view of the tab still has its real title.
			savedViews.find((item) => item.id === id) ?? {
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
		Boolean(project) && !historyPending,
		(failure) => setError(errorText(failure)),
		api,
	)
	const savedSettings = useDraftSettings(
		draftOwner,
		Boolean(project) && !historyPending,
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
	const choiceUnchosen =
		!pal &&
		isUnchosen({
			providers: activeProviders,
			draftChoice: savedSettings.value.choice,
			started: thread.messages.length > 0 || thread.running,
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
	// "Desktop | CLI": the CLI side opens the chosen engine's own command line in a terminal tab.
	const [surfacePref, setSurfacePref] = useState<EngineSurface>(() => {
		try {
			return localStorage.getItem('namzu.surface') === 'cli' ? 'cli' : 'desktop'
		} catch {
			return 'desktop'
		}
	})
	const surfaceEngine = permissionEngine ?? harnessView?.selected ?? 'namzu'
	const surfaceReason = !terminalReady
		? 'Open a trusted project to use the engine’s command line.'
		: thread.messages.length > 0 || thread.running
			? 'Start a new conversation to open this engine’s command line.'
			: undefined
	const cliSurface = surfacePref === 'cli' && !surfaceReason && !pal
	const surfaceControl: EngineSurfaceControl | undefined =
		terminalReady && !pal
			? {
					value: cliSurface ? 'cli' : 'desktop',
					onChange: (value) => {
						setSurfacePref(value)
						try {
							localStorage.setItem('namzu.surface', value)
						} catch {
							/* The choice lasts for this window. */
						}
					},
					disabled: Boolean(surfaceReason),
					reason: surfaceReason,
				}
			: undefined
	// A tab that opens beside or below the pane, or in a window of its own, joins this pane first,
	// then leaves as a move; the tab that was in front stays in front where it was.
	// The tab in front now: a terminal when one is, else the pane's active conversation.
	const frontTabNow = () =>
		(!startAtHome && terminalGroup?.activeId) || context.current.group.activeTabId
	const placeNewTab = async (tabId: string, place: NewTabPlacement | undefined, before: string) => {
		if (!place) return
		const groupId = context.current.group.id
		if (before && before !== tabId) await onAction({ kind: 'activate', groupId, tabId: before })
		if (place === 'window') onDetach(groupId, tabId)
		else onSplit(groupId, tabId, place)
	}
	const openShellTerminal = async (place?: NewTabPlacement) => {
		if (context.current.frozen || !project || !terminalReady || !window.namzu.openTerminal) return
		const before = frontTabNow()
		const opened = await window.namzu.openTerminal(shellTerminalRequest(project.id, group.id))
		await placeNewTab(opened.terminal.id, place, before)
	}
	const openConversationAt = async (place: NewTabPlacement) => {
		if (context.current.frozen) return
		let destination = normalConversationProject(projects, projectId, previousNormalProject.current)
		if (!destination) {
			if (!api.openChat) throw new Error('Restart the desktop app to open a normal conversation.')
			destination = await api.openChat()
			updateProject(destination)
		}
		if (destination.palId) throw new Error('A normal conversation cannot use a Pal workspace.')
		if (!destination.trusted || destination.status !== 'ready')
			throw new Error('Trust this project to start a conversation.')
		previousNormalProject.current = destination.id
		const before = frontTabNow()
		const view = await api.newConversation(destination.id)
		upsertConversation(view)
		await onAction({ kind: 'open', tabId: view.id, groupId: context.current.group.id })
		await placeNewTab(view.id, place, before)
	}
	const newTabMenuAction = (id: NewTabActionId) => {
		const place = (value: string): NewTabPlacement =>
			value === 'right' ? 'right' : value === 'below' ? 'bottom' : 'window'
		if (id === 'conversation') return void act(newConversation)
		if (id === 'terminal') return void act(() => openShellTerminal())
		if (id === 'window') return void act(() => openConversationAt('window'))
		const [kind, where] = id.split('-') as ['conversation' | 'terminal', string]
		return void act(() =>
			kind === 'terminal' ? openShellTerminal(place(where)) : openConversationAt(place(where)),
		)
	}
	const openShellRef = useRef(openShellTerminal)
	openShellRef.current = openShellTerminal
	const openEngineTerminal = async () => {
		if (context.current.frozen || !project || !terminalReady || !window.namzu.openTerminal) return
		const engine = surfaceEngine
		const request = engineTerminalRequest({
			engine,
			projectId: project.id,
			groupId: group.id,
			provider: choice.provider,
			model: choice.model || undefined,
			modelIsDefault: choice.preset === 'default',
			effort: effortToSend(capabilities, settings.effort),
			permissionMode: settings.permissionMode,
			draft,
		})
		const result = await window.namzu.openTerminal(request)
		if (request.kind === 'engine' && request.prompt && !result.omitted.includes(PROMPT_NOT_PASSED))
			changeDraft(draftOwner, '')
		if (result.omitted.length > 0) {
			const kept = result.omitted.includes(PROMPT_NOT_PASSED)
				? ' Windows Command Prompt would read part of the message as a command, so it stays in the composer.'
				: ''
			notify(
				`${TERMINAL_ENGINE_LABELS[engine]} started without ${result.omitted.join(' and ')}.${kept}`,
				{ tone: 'warning' },
			)
		}
	}
	// A quiet notice when an engine's terminal ends badly; one that ended before this window knew of it stays quiet.
	const terminalStatuses = useRef(new Map<string, string>())
	useEffect(() => {
		const known = terminalStatuses.current
		for (const tab of terminalGroup?.tabs ?? []) {
			const previous = known.get(tab.id)
			known.set(tab.id, tab.status)
			if (
				previous === 'running' &&
				tab.status === 'exited' &&
				tab.kind === 'engine' &&
				tab.exitCode !== undefined &&
				tab.exitCode !== 0 &&
				terminalGroup?.order.includes(tab.id)
			)
				notify(`${tab.title} exited with code ${tab.exitCode}.`, { tone: 'warning' })
		}
	}, [terminalGroup?.tabs, terminalGroup?.order])
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
							notice: 'Model settings could not be loaded. Try selecting the model again.',
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
	// An effort carried over from another model is cleared once this model's levels are known and
	// it does not offer that level; the composer then falls back to the model's own default.
	const effortIsStale = staleEffort(capabilities, settings.effort)
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a change in staleness may save
	useEffect(() => {
		if (!effortIsStale || modelSettingsBusy || !providerReady) return
		void act(() =>
			savedSettings.save(draftOwner, { choice, options: { ...settings, effort: undefined } }),
		)
	}, [effortIsStale, modelSettingsBusy, providerReady, draftOwner])
	const updateProject = useCallback(
		(item: ProjectView) =>
			setProjects((items) => [...items.filter((row) => row.id !== item.id), item]),
		[],
	)
	// A refreshed row replaces the old one in place; a copy that is new to this window leads.
	const upsertConversation = useCallback((view: ConversationView) => {
		if (removedConversations.current.has(view.id)) return
		setConversations((all) =>
			all.some((item) => item.id === view.id)
				? all.map((item) => (item.id === view.id ? view : item))
				: [view, ...all],
		)
	}, [])
	// An archived conversation is blocked from upserts and hidden from the sidebar until it is
	// restored; both records must forget it, or the restored row never comes back.
	const unblockRestoredConversation = useCallback((id: string) => {
		removedConversations.current.delete(id)
		setRemovedCatalogue((current) => {
			if (!current.conversations.has(id)) return current
			const conversations = new Set(current.conversations)
			conversations.delete(id)
			return { ...current, conversations }
		})
	}, [])
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
	const runJobAction = async <T,>(owner: string, generation: number, action: () => Promise<T>) => {
		const current = () =>
			mounted.current && activeSession.current === owner && navigation.current === generation
		if (context.current.frozen || !current()) return undefined
		const pending = Promise.resolve().then(action)
		operations.current.add(pending)
		try {
			const result = await pending
			return current() ? result : undefined
		} catch (failure) {
			if (current()) throw failure
			return undefined
		} finally {
			operations.current.delete(pending)
		}
	}
	const retryConversationSetup = async () => {
		if (!project || !project.trusted || project.status !== 'ready' || harnessBusy) return
		invalidateModelCatalogueDisplayCache(window.namzu, project.id)
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
	const [palsRetry, setPalsRetry] = useState(0)
	useEffect(() => {
		let current = true
		void palsRetry
		setPalsLoading(true)
		setPalsLoadFailed(false)
		void api
			.pals()
			.then((items) => {
				if (current) setPals(items)
			})
			.catch((failure) => {
				if (!current) return
				setPalsError(errorText(failure))
				setPalsLoadFailed(true)
			})
			.finally(() => {
				if (current) setPalsLoading(false)
			})
		return () => {
			current = false
		}
	}, [api, palsRetry])
	useEffect(() => {
		if (!api.backgroundWorkStatuses) return
		let current = true
		const versions = new Map(backgroundWorkVersions.current)
		void api.backgroundWorkStatuses().then(
			(statuses) => {
				if (!current) return
				setBackgroundWork((all) => {
					const next = { ...all }
					for (const [id, status] of Object.entries(statuses)) {
						if (
							!removedConversations.current.has(id) &&
							backgroundWorkVersions.current.get(id) === versions.get(id)
						)
							next[id] = status
					}
					return next
				})
			},
			() => {},
		)
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
			if (event.kind === 'background-work-status') {
				if (
					removedConversations.current.has(event.sessionId) ||
					removedProjects.current.has(event.projectId)
				)
					return
				backgroundWorkVersions.current.set(
					event.sessionId,
					(backgroundWorkVersions.current.get(event.sessionId) ?? 0) + 1,
				)
				setBackgroundWork((all) => ({
					...all,
					[event.sessionId]: event.status,
				}))
				return
			}
			if (event.kind === 'pal-deleted') {
				removedPals.current.add(event.palId)
				const ids = new Set(event.sessionIds)
				const projectIds = new Set(event.projectIds)
				for (const item of catalogueRows.current.projects)
					if (item.palId === event.palId) projectIds.add(item.id)
				for (const item of catalogueRows.current.conversations)
					if (item.palId === event.palId || projectIds.has(item.projectId)) ids.add(item.id)
				for (const id of projectIds) {
					removedProjects.current.add(id)
					warmSessions.current.invalidateProject(id)
					invalidateModelCatalogueDisplayCache(window.namzu, id)
				}
				for (const id of ids) {
					removedConversations.current.add(id)
					loadedHistory.current.delete(id)
					warmSessions.current.forget(id)
					createdSessions.current.delete(id)
					draftEditRevisions.current.delete(id)
					draftAdmissions.current.delete(id)
				}
				setRemovedCatalogue({
					pals: new Set(removedPals.current),
					projects: new Set(removedProjects.current),
					conversations: new Set(removedConversations.current),
				})
				setPals((all) => all.filter((item) => item.id !== event.palId))
				setProjects((all) => all.filter((item) => !projectIds.has(item.id)))
				setConversations((all) => all.filter((item) => !ids.has(item.id)))
				setThreads((all) => omitRecords(all, ids))
				setBackgroundWork((all) => omitRecords(all, ids))
				setDrafts((all) => omitRecords(all, ids))
				draftsRef.current = omitRecords(draftsRef.current, ids)
				setEditingPal((value) => (value?.id === event.palId ? undefined : value))
				setDeletingPal((value) => (value?.id === event.palId ? undefined : value))
				setCommunicationOwner((value) => (value?.palId === event.palId ? undefined : value))
				setPalScreen((value) => (value?.palId === event.palId ? undefined : value))
				setPalComputers((all) => omitRecords(all, new Set([event.palId])))
				setPalScreens((all) => omitRecords(all, new Set([event.palId])))
				if (ids.has(activeSession.current)) {
					navigation.current++
					snapshotRead.current = null
					invalidateComputerInput()
					setSessionId('')
					setProjectId('')
					setHistoryDisplay(null)
				}
				return
			}
			if (event.kind === 'settings' || event.kind === 'terminals') return
			if (event.kind === 'tab-command') {
				if (context.current.focused && !context.current.frozen)
					runTabChordRef.current({ kind: event.command })
				return
			}
			if (event.kind === 'open-settings') {
				if (context.current.focused && !context.current.frozen)
					openSettingsRef.current(event.section)
				return
			}
			if (event.kind === 'project-removed') {
				const ids = new Set(event.sessionIds)
				for (const item of catalogueRows.current.conversations)
					if (item.projectId === event.projectId) ids.add(item.id)
				removedProjects.current.add(event.projectId)
				warmSessions.current.invalidateProject(event.projectId)
				invalidateModelCatalogueDisplayCache(window.namzu, event.projectId)
				for (const id of ids) {
					removedConversations.current.add(id)
					loadedHistory.current.delete(id)
					warmSessions.current.forget(id)
					createdSessions.current.delete(id)
					draftEditRevisions.current.delete(id)
					draftAdmissions.current.delete(id)
				}
				setRemovedCatalogue({
					pals: new Set(removedPals.current),
					projects: new Set(removedProjects.current),
					conversations: new Set(removedConversations.current),
				})
				setProjects((all) => all.filter((item) => item.id !== event.projectId))
				setConversations((all) => all.filter((item) => !ids.has(item.id)))
				setThreads((all) => omitRecords(all, ids))
				setBackgroundWork((all) => omitRecords(all, ids))
				setDrafts((all) => omitRecords(all, ids))
				draftsRef.current = omitRecords(draftsRef.current, ids)
				setRemovingProject((value) => (value?.id === event.projectId ? undefined : value))
				if (ids.has(activeSession.current) || activeProjectId.current === event.projectId) {
					navigation.current++
					snapshotRead.current = null
					invalidateComputerInput()
					setSessionId('')
					setProjectId('')
					setHistoryDisplay(null)
				}
				return
			}
			if (event.kind === 'conversation-removed') {
				const id = event.sessionId
				const ids = new Set([id])
				removedConversations.current.add(id)
				setRemovedCatalogue({
					pals: new Set(removedPals.current),
					projects: new Set(removedProjects.current),
					conversations: new Set(removedConversations.current),
				})
				loadedHistory.current.delete(id)
				warmSessions.current.forget(id)
				createdSessions.current.delete(id)
				draftEditRevisions.current.delete(id)
				draftAdmissions.current.delete(id)
				setConversations((all) => all.filter((item) => item.id !== id))
				setThreads((all) => omitRecords(all, ids))
				setBackgroundWork((all) => omitRecords(all, ids))
				setDrafts((all) => omitRecords(all, ids))
				draftsRef.current = omitRecords(draftsRef.current, ids)
				setRemovingConversation((value) => (value?.id === id ? undefined : value))
				if (
					snapshotRead.current?.sessionId === id ||
					openFlights.current.get(id)?.generation === navigation.current
				)
					navigation.current++
				if (activeSession.current === id) {
					navigation.current++
					snapshotRead.current = null
					setSessionId('')
					setHistoryDisplay(null)
				}
				return
			}
			if (event.kind === 'conversation-updated') {
				// Rename and pin come from any window; tabs, sidebar and recents read this one list.
				upsertConversation(event.view)
				return
			}
			if (event.kind === 'connection') {
				// A message about a dropped connection ends with the drop: once Namzu is back it is stale.
				if (event.project.lost) lostProjects.current.add(event.project.id)
				else if (lostProjects.current.delete(event.project.id) && event.project.status === 'ready')
					setError('')
				// While the connection is down the conversation stays exactly as it is on screen; only
				// the way back (a ready project) forgets what was read and reads it again.
				if (event.project.lost) {
					updateProject(event.project)
					return
				}
				const ids = new Set(
					catalogueRows.current.conversations
						.filter((item) => item.projectId === event.project.id)
						.map((item) => item.id),
				)
				for (const id of ids)
					backgroundWorkVersions.current.set(id, (backgroundWorkVersions.current.get(id) ?? 0) + 1)
				setBackgroundWork((all) => omitRecords(all, ids))
				warmSessions.current.invalidateProject(event.project.id)
				invalidateModelCatalogueDisplayCache(window.namzu, event.project.id)
				if (event.project.palId) palCatalogueActivity.current.changed(event.project.palId)
				for (const [id, owner] of loadedHistory.current)
					if (owner.projectId === event.project.id) loadedHistory.current.delete(id)
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
			if (event.kind === 'model-catalogue-updated') {
				modelCatalogueDisplayCacheForApi(window.namzu).catalogueUpdated(
					event.engine,
					event.provider,
				)
				return
			}
			if (event.kind === 'providers-changed') {
				// A key was saved or removed. Forget what each pane remembered about providers
				// and read them again; the send button follows the new answer.
				warmSessions.current.invalidateAll()
				providerGeneration.current++
				setProviderOwner('')
				setMetadataEpoch((epoch) => epoch + 1)
				return
			}
			const id = event.kind === 'permission' ? event.request.sessionId : event.sessionId
			if (removedConversations.current.has(id)) return
			if (event.kind === 'state') {
				const admission = draftAdmissions.current.get(id)
				if (admission && event.running) admission.started = true
				if (event.restoredDraft !== undefined) {
					const restoredDraft = event.restoredDraft
					if (admission) admission.restored = true
					const editRevision = draftEditRevisions.current.get(id) ?? 0
					const currentDraft = draftsRef.current[id] ?? ''
					if (
						(admission
							? admission.prompt === restoredDraft && admission.editRevision === editRevision
							: editRevision === 0) &&
						(!currentDraft || currentDraft === restoredDraft)
					) {
						draftsRef.current[id] = restoredDraft
						setDrafts((all) => ({ ...all, [id]: restoredDraft }))
					}
				}
				if (
					!event.running &&
					(admission?.started || event.error || event.restoredDraft !== undefined)
				)
					draftAdmissions.current.delete(id)
			}
			if (event.kind === 'live-input' && event.status === 'delivered') {
				const admission = draftAdmissions.current.get(id)
				if (
					admission?.prompt === event.prompt &&
					admission.editRevision === (draftEditRevisions.current.get(id) ?? 0) &&
					draftsRef.current[id] === event.prompt
				) {
					draftsRef.current[id] = ''
					setDrafts((all) => ({ ...all, [id]: '' }))
				}
			}
			if (event.kind === 'prompt' || event.kind === 'update' || event.kind === 'retry') {
				const rows = catalogueRows.current
				const owner =
					rows.conversations.find((item) => item.id === id)?.palId ??
					(event.kind === 'update'
						? rows.projects.find((item) => item.id === event.projectId)?.palId
						: undefined)
				if (owner) palCatalogueActivity.current.changed(owner)
			}
			const read = snapshotRead.current
			if (read?.sessionId === id && read.generation === navigation.current && !read.overflow) {
				read.characters += JSON.stringify(event).length
				if (read.characters > 8 * 1024 * 1024 || read.events.length >= 10_000) {
					read.overflow = true
					read.events.length = 0
				} else read.events.push(event)
			}
			if (event.kind === 'attachment-previews-evicted') {
				setThreads((all) => applyCachedAttachmentPreviewEviction(all, event))
				return
			}
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
			setThreads((all) => ({
				...all,
				[id]: applyEvent(all[id] ?? emptyThread(), event),
			}))
			if (event.kind === 'state' && !event.running) {
				const generation = navigation.current
				void attached.reload(event.sessionId).catch((failure) => {
					if (
						mounted.current &&
						activeSession.current === event.sessionId &&
						navigation.current === generation
					)
						setError(errorText(failure))
				})
			}
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
	}, [updateProject, upsertConversation, attached.reload, api, invalidateComputerInput])
	useEffect(() => {
		// Choice settlement resumes metadata admission even for the same active ID.
		void metadataEpoch
		if (!project || project.status === 'connecting' || !project.trusted || historyPending) return
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
	}, [project, sessionId, api, metadataEpoch, historyPending])
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
		if (
			!sessionId ||
			!api ||
			palConversation ||
			historyPending ||
			restoringTabs ||
			!((detailsOpen && panelView === 'activity') || detailsPopoverOpen)
		) {
			setJobs([])
			setJobsSessionId('')
			return
		}
		let current = true
		let pending: Promise<void> | undefined
		setJobs([])
		setJobsSessionId(sessionId)
		setJobsLoading(true)
		setJobsError('')
		const read = (): Promise<void> => {
			if (pending) return pending
			pending = (async () => {
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
					pending = undefined
					if (current) setJobsLoading(false)
				}
			})()
			return pending
		}
		// A stop refresh follows any older in-flight poll, so that an older
		// running snapshot cannot overwrite the newly confirmed terminal state.
		const refresh = async () => {
			if (pending) await pending
			if (current) await read()
		}
		refreshJobs.current = refresh
		void read()
		const timer = setInterval(() => void read(), 2000)
		return () => {
			current = false
			if (refreshJobs.current === refresh) refreshJobs.current = undefined
			clearInterval(timer)
		}
	}, [
		sessionId,
		palConversation,
		api,
		historyPending,
		restoringTabs,
		detailsOpen,
		panelView,
		detailsPopoverOpen,
	])
	const palTasksVisible = Boolean(
		pal &&
			(palScreen?.palId === pal.id && palScreen.activeTab === 'computer'
				? computerProfileOpen
				: palProfileOpen),
	)
	useEffect(() => {
		if (
			!sessionId ||
			!api?.refreshTasks ||
			historyPending ||
			restoringTabs ||
			(!palTasksVisible && (!detailsOpen || panelView !== 'activity'))
		)
			return
		let current = true
		void api.refreshTasks(sessionId).catch((failure) => {
			if (current) setError(errorText(failure))
		})
		return () => {
			current = false
		}
	}, [sessionId, detailsOpen, panelView, palTasksVisible, api, historyPending, restoringTabs])
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
		if (
			!api.harnesses ||
			!project ||
			pal ||
			!project.trusted ||
			project.status !== 'ready' ||
			historyPending ||
			restoringTabs
		)
			return
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
	}, [project, pal, sessionId, providerKey, api, metadataEpoch, historyPending, restoringTabs])
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
		// Providers and the engine view were read for the current pane and applied.
		let applied = false
		harnessChoicePending.current = true
		setHarnessBusy(true)
		setStartingEngine(engine)
		try {
			const create = !target || harnessView?.locked || thread.messages.length > 0
			if (create) {
				const view = await api.newConversation(sourceProject.id)
				target = view.id
				// Held before the pane shows it: the awaits below let tab restore run in between.
				paneHold.current = target
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
			if (!context.current.group.tabs.includes(target)) paneHold.current = target
			finishMutation = warmSessions.current.beginMutation(target)
			setMetadataEpoch((epoch) => epoch + 1)
			const view = await api.selectHarness(target, engine)
			invalidateModelCatalogueDisplayCache(window.namzu, sourceProject.id)
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
			// The two reads are independent; waiting for one before starting the other doubled the time
			// the trigger spent on the previous engine.
			const [, available] = await Promise.all([
				savedSettings.save(target, {
					options: { permissionMode: 'prompt' },
				}),
				api.providers(sourceProject.id, target),
			])
			if (generation !== navigation.current) return
			setProviders(available)
			setProviderOwner(owner)
			applied = true
		} catch (failure) {
			if (finishMutation)
				harnessChoiceFailure.current = {
					sessionId: target,
					message: errorText(failure),
				}
			throw failure
		} finally {
			harnessChoicePending.current = false
			setHarnessBusy(false)
			setStartingEngine(undefined)
			if (finishMutation) {
				// A user may return to this owner while its choice ACK is pending.
				// Retire visible metadata before waking that activation, regardless
				// of the navigation generation which initiated the mutation.
				const tabbed = context.current.group.tabs.includes(target)
				// A pane that is not a tab has nothing to restore: re-arming tab restore opened another
				// tab, or cleared the pane, and the engine choice vanished with it.
				if (
					tabbed &&
					(activeSession.current === target || context.current.group.activeTabId === target)
				) {
					providerGeneration.current++
					harnessGeneration.current++
					hydratedSession.current = null
					activation.current = null
					setProviderOwner('')
					setHarnessState(undefined)
					setModelSettings(null)
					setRestoringTabs(true)
				}
				// Everything this pane shows was just read and applied; reading it all again is the
				// duplicate that kept the trigger on its placeholder.
				if (tabbed || !applied || generation !== navigation.current)
					setMetadataEpoch((epoch) => epoch + 1)
				finishMutation()
			}
		}
	}

	const createProjectDraft = useCallback(
		async (item: ProjectView) => {
			if (!item.trusted || item.status !== 'ready') return ''
			// After a restart nothing remembers which conversation was the project's draft, so an
			// untouched one that is already in the list is reused before another is made.
			const candidate =
				projectDrafts.current.get(item.id) ??
				emptyProjectConversation(catalogueRows.current.conversations, item.id)
			const reused = reusableProjectDraft({
				candidate,
				projectId: item.id,
				conversations: catalogueRows.current.conversations,
				thread: threadsRef.current[candidate ?? ''],
				draftText: draftsRef.current[candidate ?? ''],
			})
			if (reused) {
				projectDrafts.current.set(item.id, reused)
				return reused
			}
			const view = await api.newConversation(item.id)
			projectDrafts.current.set(item.id, view.id)
			setConversations((all) => [view, ...all.filter((row) => row.id !== view.id)])
			setThreads((all) => ({ ...all, [view.id]: emptyThread() }))
			return view.id
		},
		[api],
	)
	// The composer is usable while a project's conversation is still being made, and what a person
	// types in that gap lives under the pane's own key. The landing hands it on once the new
	// conversation is the pane's owner: text typed up to the render that shows it is still carried.
	const pendingCarry = useRef<{ projectKey: string; target: string } | undefined>(undefined)
	const carryPendingDraftRef = useRef((_projectKey: string, _target: string) => {})
	carryPendingDraftRef.current = (projectKey, target) => {
		const owner = `project:${projectKey}:workspace:${windowId}:${group.id}`
		const text = draftsRef.current[owner] ?? ''
		const files = attached.get(owner).length > 0
		if (!target || owner === target || (!text && !files)) return
		if (text && !(draftsRef.current[target] ?? '')) {
			draftsRef.current[target] = text
			setDrafts((all) => ({ ...all, [target]: text }))
			void api.saveDraft(target, text).catch((failure) => setError(errorText(failure)))
		}
		draftsRef.current[owner] = ''
		setDrafts((all) => ({ ...all, [owner]: '' }))
		void api.saveDraft(owner, '').catch((failure) => setError(errorText(failure)))
		if (files) void attached.promote(owner, target)
	}
	const carryPendingDraft = useCallback((projectKey: string, target: string) => {
		pendingCarry.current = { projectKey, target }
	}, [])
	useEffect(() => {
		const carry = pendingCarry.current
		if (!carry || carry.target !== draftOwner) return
		pendingCarry.current = undefined
		carryPendingDraftRef.current(carry.projectKey, carry.target)
	})
	const composerFocusFor = useRef(-1)
	useEffect(() => {
		const field = input.current
		if (composerFocusFor.current !== navigation.current || !field || field.disabled) return
		if (!context.current.focused || context.current.frozen) return
		composerFocusFor.current = -1
		field.focus()
	})
	// A folder this app trusted whose automatic settings changed asks again, once per change,
	// as soon as it is known: until the person answers it behaves as untrusted.
	const promptedChanges = useRef(new Map<string, string>())
	useEffect(() => {
		if (folderAccess) return
		for (const item of projects) {
			if (item.trusted || item.status !== 'ready' || !item.settingsChanged?.length) continue
			const signature = item.settingsChanged.join('|')
			if (promptedChanges.current.get(item.id) === signature) continue
			promptedChanges.current.set(item.id, signature)
			setFolderAccess({ projectId: item.id })
			return
		}
	}, [projects, folderAccess])
	// A project that was just added lands on its home with the composer focused; there is no
	// step in between for a trusted one.
	const landOnProject = useCallback(
		async (item: ProjectView, generation: number) => {
			updateProject(item)
			// Main trusted an ordinary pick itself; a broad folder or one with settings that run
			// code waits for the dialog.
			if (item.broadFolder) setFolderAccess({ projectId: item.id, broad: item.broadFolder })
			else if (item.riskySettings)
				setFolderAccess({ projectId: item.id, risky: item.riskySettings })
			if (generation !== navigation.current) return
			const target = await createProjectDraft(item)
			if (generation !== navigation.current) return
			carryPendingDraft(item.id, target)
			setProjectId(item.id)
			setSessionId(target)
			setConversationSelection(null)
			setPalScreen(undefined)
			setRailSection(null)
			setPalsPage(false)
			setSideOpen(false)
			setJobsOpen(false)
			// The composer of a project that was just added mounts, and is enabled, after this
			// render; a menu that started the add hands focus back to its button as it closes.
			// The effect below focuses it once it can take focus, for this navigation only.
			composerFocusFor.current = generation
			if (context.current.focused && !context.current.frozen) input.current?.focus()
		},
		[updateProject, createProjectDraft, carryPendingDraft],
	)
	// What a pick (or an add-back) answered: a folder that still needs an answer waits in the
	// dialog and is not in the app yet; any other lands on its home.
	const adoptPicked = useCallback(
		async (item: ProjectView | null, generation: number) => {
			if (item?.pending && (item.riskySettings || item.broadFolder)) {
				// Not in the app yet: only a confirmed answer adds it, and cancelling adds nothing.
				setFolderAccess({
					projectId: item.id,
					risky: item.riskySettings,
					broad: item.broadFolder,
					pending: { name: item.name, path: item.path },
				})
			} else if (item) await landOnProject(item, generation)
		},
		[landOnProject],
	)
	const openProject = useCallback(async () => {
		abandonTabRestore()
		const generation = ++navigation.current
		setLoading(true)
		try {
			await adoptPicked(await api.openProject(), generation)
		} catch (failure) {
			if (generation === navigation.current) throw failure
		} finally {
			if (generation === navigation.current) setLoading(false)
		}
	}, [abandonTabRestore, adoptPicked, api])
	const locateProject = useCallback(
		async (value: ProjectView) => {
			if (!api.locateProject) return
			abandonTabRestore()
			const generation = ++navigation.current
			setLoading(true)
			try {
				await adoptPicked(await api.locateProject(value.id), generation)
			} catch (failure) {
				if (generation === navigation.current) throw failure
			} finally {
				if (generation === navigation.current) setLoading(false)
			}
		},
		[abandonTabRestore, adoptPicked, api],
	)
	const createProject = useCallback(async () => {
		abandonTabRestore()
		const generation = ++navigation.current
		setLoading(true)
		try {
			if (!api.createProject)
				throw newProjectFailure(new Error('Restart the desktop app, then try again.'))
			let item: ProjectView
			try {
				item = await api.createProject()
			} catch (failure) {
				throw newProjectFailure(failure)
			}
			await landOnProject(item, generation)
			// Nothing else says where a project made from scratch lives.
			notify(createdProjectNotice(item), {
				tone: 'success',
				timeoutMs: 12_000,
				action: api.openProjectPath
					? {
							label: 'Show in folder',
							onClick: () =>
								void act(async () => {
									await api.openProjectPath?.(item.id, '', 'file-manager')
								}),
						}
					: undefined,
			})
		} catch (failure) {
			if (generation === navigation.current) throw failure
		} finally {
			if (generation === navigation.current) setLoading(false)
		}
	}, [abandonTabRestore, landOnProject, api, act])
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
			carryPendingDraft(item.id, target)
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
			carryPendingDraft(id, target)
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
			if (removedConversations.current.has(view.id) || removedProjects.current.has(view.projectId))
				return Promise.resolve()
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
				const previousHistory = loadedHistory.current.get(view.id)
				const retained =
					previousHistory?.projectId === view.projectId &&
					previousHistory.connection === ticket.connection
				const read = {
					generation,
					sessionId: view.id,
					events: [] as DesktopEvent[],
					characters: 0,
					overflow: false,
				}
				snapshotRead.current = remembered ? null : read
				let shown = false
				const showConversation = () => {
					if (shown) return
					shown = true
					setSessionId(view.id)
					setConversationSelection({ sessionId: view.id, collection })
					setProjectId(view.projectId)
					setRailSection(null)
					setPalsPage(false)
					setSideOpen(false)
					// This view record is scoped to the selected catalogue conversation;
					// it never supplies history or write authority.
					const presentation = readWorkspacePresentation(localStorage, view.id, view.palId)
					const disclosureView = {
						sessionId: view.id,
						choices: presentation?.workDisclosures ?? {},
					}
					workDisclosureViewRef.current = disclosureView
					setWorkDisclosureView(disclosureView)
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
						setPanelExpanded(presentation.panelExpanded ?? false)
						follow.current = presentation.follow
						pendingPresentationScroll.current = {
							generation,
							sessionId: view.id,
							scrollTop: presentation.scrollTop,
							follow: presentation.follow,
						}
					} else {
						setJobsOpen(false)
						setPanelExpanded(false)
						follow.current = true
						pendingPresentationScroll.current = null
					}
				}
				try {
					let status = remembered?.providers
					if (!remembered) {
						// Retained messages are a saved display, never admission. Main's
						// current history and all metadata must still succeed before actions.
						setRestoringTabs(true)
						hydratedSession.current = null
						setProviderOwner('')
						setHistoryDisplay({
							sessionId: view.id,
							saved: retained,
							refreshing: true,
							pending: !retained,
						})
						showConversation()
						const readMetadata = () =>
							Promise.all([
								api.providers(view.projectId, view.id),
								api.draft(view.id).then((savedDraft) => {
									// The owned local draft can be displayed while model readiness
									// is pending. Publishing it does not enable the composer.
									if (
										generation === navigation.current &&
										(restoring || draftsRef.current[view.id] === undefined)
									) {
										draftsRef.current[view.id] = savedDraft
										setDrafts((all) => ({ ...all, [view.id]: savedDraft }))
									}
									return savedDraft
								}),
								savedSettings.refresh(view.id),
								attached.reload(view.id),
							])
						// A retained session already exists in main. Its independent metadata
						// can overlap history; first opens wait for main registration.
						const metadata = retained ? readMetadata() : undefined
						void metadata?.catch(() => {})
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
						loadedHistory.current.set(view.id, {
							projectId: view.projectId,
							connection: ticket.connection,
						})
						setHistoryDisplay({
							sessionId: view.id,
							saved: false,
							refreshing: false,
						})
						showConversation()
						const [[available, savedDraft]] = await Promise.all([
							metadata ?? readMetadata(),
							api.readyConversation?.(view.projectId, view.id),
						])
						if (generation !== navigation.current) return
						status = available
						if (restoring || draftsRef.current[view.id] === undefined) {
							draftsRef.current[view.id] = savedDraft
							setDrafts((all) => ({ ...all, [view.id]: savedDraft }))
						}
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
					if (remembered) showConversation()
					setTabsRestored(true)
					setRestoringTabs(false)
					if (context.current.focused && !context.current.frozen) input.current?.focus()
				} catch (failure) {
					if (generation === navigation.current) {
						setHistoryDisplay((current) =>
							current?.sessionId === view.id ? { ...current, refreshing: false } : current,
						)
						throw failure
					}
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
		// Opening an indexed Recent only changes membership, not the catalogue.
		// Unknown transferred/restored IDs still require an authoritative listing.
		if (
			catalogueReady &&
			catalogueOwner.current?.projects === projects &&
			(catalogueOwner.current.tabsKey === catalogueTabsKey ||
				group.tabs.every((id) => conversations.some((item) => item.id === id)))
		) {
			catalogueOwner.current = { projects, tabsKey: catalogueTabsKey }
			return
		}
		const readable = projects.filter((item) => item.trusted && item.status === 'ready')
		const activities = readable.map((item) =>
			item.palId ? palCatalogueActivity.current.ticket(item.palId) : undefined,
		)
		void Promise.allSettled(readable.map((item) => api.conversations(item.id))).then((results) => {
			if (!current) return
			for (const [index, result] of results.entries()) {
				const palId = readable[index]?.palId
				const activity = activities[index]
				if (!palId || activity === undefined) continue
				if (result.status === 'fulfilled') palCatalogueActivity.current.confirm(palId, activity)
				else palCatalogueActivity.current.changed(palId)
			}
			catalogueOwner.current = { projects, tabsKey: catalogueTabsKey }
			const rows = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
			const refreshed = readable
				.filter((_item, index) => results[index]?.status === 'fulfilled')
				.map((item) => item.id)
			setConversations((all) => mergeConversationCatalogues(all, rows, refreshed))
			setCatalogueReady(true)
		})
		return () => {
			current = false
		}
	}, [
		api,
		projects,
		catalogueTabsKey,
		tabRestoreAttempt,
		conversations,
		group.tabs,
		catalogueReady,
	])
	useEffect(() => {
		void metadataEpoch
		setOpenTabIds([...group.tabs])
		if (paneHold.current) {
			if (paneHold.current === sessionId && !group.tabs.includes(sessionId)) {
				setTabsRestored(true)
				setRestoringTabs(false)
				return
			}
			paneHold.current = ''
		}
		const target = startAtHome ? '' : group.activeTabId || ''
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
			const savedOwner = projects.find(
				(item) => item.id === savedViews.find((row) => row.id === target)?.projectId,
			)
			// Its folder is connected but not trusted here (new, or its settings changed), so
			// nothing can be listed: the trust dialog explains, not a load failure.
			if (savedOwner?.status === 'ready' && !savedOwner.trusted) {
				setTabsRestored(true)
				setRestoringTabs(false)
				return
			}
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
		const opening = openConversation(view, 'projects', true)
		const generation = navigation.current
		const current = () =>
			generation === navigation.current &&
			activation.current === target &&
			context.current.group.activeTabId === target
		void opening
			.then(() => {
				if (!current()) return
				setTabsRestored(true)
				setRestoringTabs(false)
			})
			.catch((failure) => {
				if (!current()) return
				if (conversationIsGone(failure)) {
					// Its journal is gone: there is nothing to open, so the tab closes and the
					// project's home shows instead of an error over an empty composer.
					activation.current = null
					setError('')
					setConversations((all) => all.filter((item) => item.id !== target))
					void api.removeConversation?.(target).catch(() => undefined)
					void onAction({ kind: 'close', groupId: context.current.group.id, tabId: target })
						.catch((closeFailure) => setError(errorText(closeFailure)))
						.finally(() => {
							setSessionId('')
							setConversationSelection(null)
							setTabsRestored(true)
							setRestoringTabs(false)
						})
					return
				}
				setError(errorText(failure))
				onLoadFailure(target, failure)
			})
	}, [
		group.activeTabId,
		startAtHome,
		savedViews,
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
		onAction,
		api,
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
	const requestPalDeletion = (value: PalView) => {
		if (context.current.frozen || palsSaving || !api.deletePal) return
		removalTrigger.current =
			document.activeElement instanceof HTMLElement ? document.activeElement : null
		setDeletingPal(value)
	}
	const requestConversationRemoval = (value: ConversationView, trigger: HTMLElement | null) => {
		if (context.current.frozen || value.palId || !api.removeConversation) return
		removalTrigger.current = trigger
		setRemovingConversation(value)
	}
	// Archives and offers Undo through the same host path whether the dialog or a row button asked.
	const archiveConversation = async (value: ConversationView) => {
		if (!api.removeConversation) throw new Error('Conversation removal is unavailable.')
		const result = await api.removeConversation(value.id)
		if (result.sessionId !== value.id || result.removed !== true)
			throw new Error('Conversation removal was not confirmed. Try again.')
		const archivedId = value.id
		notify('Conversation archived. Find it under Archived conversations in the sidebar.', {
			tone: 'success',
			timeoutMs: ARCHIVE_UNDO_MS,
			action: api.restoreConversation
				? {
						label: 'Undo',
						onClick: () =>
							void act(async () => {
								const restored = await api.restoreConversation?.(archivedId)
								if (!restored) return
								unblockRestoredConversation(restored.id)
								upsertConversation(restored)
							}),
					}
				: undefined,
		})
	}
	// A row's Archive button: with an Undo path there is nothing to confirm, so it archives at once.
	const archiveConversationNow = (value: ConversationView, trigger: HTMLElement | null) => {
		if (context.current.frozen || value.palId || !api.removeConversation) return
		if (!api.restoreConversation) return requestConversationRemoval(value, trigger)
		void act(() => confirmedRemoval(() => archiveConversation(value)))
	}
	const requestProjectRemoval = (value: ProjectView, trigger: HTMLElement | null) => {
		if (context.current.frozen || value.palId || value.isChat || !api.removeProject) return
		projectRemovalTrigger.current = trigger
		setRemovingProject(value)
	}
	const requestProjectRename = (value: ProjectView, trigger: HTMLElement | null) => {
		if (context.current.frozen || value.palId || value.isChat || !api.renameProject) return
		projectRenameTrigger.current = trigger
		setRenamingProject(value)
	}
	const removeProject = async (value: ProjectView) => {
		if (!api.removeProject) throw new Error('Removing a project is unavailable.')
		const result = await api.removeProject(value.id)
		if (result.projectId !== value.id)
			throw new Error('Removing the project was not confirmed. Try again.')
		const readd = result.readdToken
		const restore = api.restoreProject
		notify(removalNotice(value.name, result.trust), {
			tone: 'success',
			timeoutMs: readd && restore ? 10_000 : result.trust.state === 'removed' ? undefined : 10_000,
			action:
				readd && restore
					? {
							label: 'Add it again',
							onClick: () =>
								void act(async () => {
									const generation = ++navigation.current
									await adoptPicked(await restore(readd), generation)
								}),
						}
					: undefined,
		})
	}
	const projectRemovalReturnFocus = () =>
		projectRemovalTrigger.current?.isConnected
			? projectRemovalTrigger.current
			: (document.getElementById('settings-content') ??
				document.querySelector<HTMLElement>('.sidebar-new-conversation'))
	const removalReturnFocus = () =>
		removalTrigger.current?.isConnected
			? removalTrigger.current
			: document.querySelector<HTMLElement>('.sidebar-new-conversation')
	const confirmedRemoval = async (action: () => Promise<unknown>) => {
		if (context.current.frozen) throw new Error('Wait for this conversation to finish moving.')
		const pending = Promise.resolve().then(action)
		operations.current.add(pending)
		try {
			await pending
		} finally {
			operations.current.delete(pending)
		}
	}
	const macPlatform = /Mac/.test(navigator.platform)
	const conversationActionInput = (view: ConversationView): ConversationActionInput => {
		const owner = projects.find((item) => item.id === view.projectId)
		const isPal = Boolean(view.palId || owner?.palId)
		const state = view.id === sessionId ? thread : (threads[view.id] ?? emptyThread())
		const work =
			isPal || (view.harness && view.harness !== 'namzu')
				? ({ state: 'unavailable' } as const)
				: freshBackgroundWorkStatus(backgroundWork[view.id])
		return {
			view,
			isPal,
			running: state.running,
			queued: state.queued.length,
			permissions: state.permissions.length,
			backgroundRunning: work.state === 'known' ? work.runningCount : 0,
			hasMessages: state.messages.length > 0,
			hasReply: lastReplyText(state.messages) !== undefined,
			hasProjectPath: Boolean(owner && !owner.isChat && !owner.palId && owner.path),
			editorLabel: editors[0]?.label,
			canMoveRight: group.tabs.length > 1,
			can: {
				rename: Boolean(api.renameConversation),
				pin: Boolean(api.setConversationPinned),
				fork: Boolean(api.forkConversation),
				markdown: Boolean(api.conversationMarkdown),
				copy: Boolean(window.namzu?.copyText),
				archive: Boolean(api.removeConversation),
				moveRight: true,
				moveWindow: true,
				openIn: Boolean(api.openProjectPath),
			},
		}
	}
	// An edit card names the path the tool wrote; the host maps it to the project's own path.
	const openChangedFile = (path: string) => {
		if (!projectFiles) return
		void projectFiles.resolve([path]).then((found) => {
			const hit = found.get(path)
			if (hit) projectFiles.open(hit.path, hit.line)
			else notify('That file is not in this project.', { tone: 'warning' })
		})
	}
	// The host already confirmed a working-tree path is inside the folder, so there is no link to look up.
	const openWorkingTreeFile = (path: string) => projectFiles?.open(path)
	const openWorkingTreeFileInEditor = (path: string) => {
		if (!filesProjectId || !api.openProjectPath) return
		void act(() => api.openProjectPath?.(filesProjectId, path, 'editor') ?? Promise.resolve())
	}
	const openChangedFileInEditor = (path: string) => {
		if (!projectFiles || !api.openProjectPath) return
		void projectFiles.resolve([path]).then((found) => {
			const hit = found.get(path)
			if (hit && filesProjectId)
				void act(
					() =>
						api.openProjectPath?.(filesProjectId, hit.path, 'editor', hit.line) ??
						Promise.resolve(),
				)
			else notify('That file is not in this project.', { tone: 'warning' })
		})
	}
	const copyToClipboard = async (text: string, done: string) => {
		await copyPlainText(text)
		notify(done, { tone: 'success' })
	}
	const runConversationAction = (
		id: ConversationActionId,
		view: ConversationView,
		trigger: HTMLElement | null,
	) => {
		if (context.current.frozen) return
		const state = view.id === sessionId ? thread : (threads[view.id] ?? emptyThread())
		switch (id) {
			case 'rename':
				if (!api.renameConversation) return
				renameTrigger.current = trigger
				setRenamingConversation(view)
				return
			case 'pin':
				if (!api.setConversationPinned) return
				void act(async () => {
					const next = await api.setConversationPinned?.(view.id, !view.pinned)
					if (!next) return
					upsertConversation(next)
					notify(next.pinned ? 'Conversation pinned.' : 'Conversation unpinned.', {
						tone: 'success',
						action: {
							label: 'Undo',
							onClick: () =>
								void act(async () => {
									const back = await api.setConversationPinned?.(view.id, !next.pinned)
									if (back) upsertConversation(back)
								}),
						},
					})
				})
				return
			case 'fork':
				if (!api.forkConversation) return
				void act(async () => {
					const copy = await api.forkConversation?.(view.id)
					if (!copy) return
					upsertConversation(copy)
					await openConversation(copy)
				})
				return
			case 'side-chat':
				if (!api.forkConversation) return
				void act(async () => {
					const copy = await api.forkConversation?.(view.id)
					if (!copy) return
					upsertConversation(copy)
					// The copy joins this pane first so that it can leave as a split to the right.
					const groupId = context.current.group.id
					await onAction({ kind: 'open', tabId: copy.id, groupId })
					// Opening activates the copy here; bring the source back before the copy leaves,
					// so the left pane keeps showing the conversation the side chat came from.
					await onAction({ kind: 'activate', groupId, tabId: view.id })
					onSplit(groupId, copy.id, 'right')
				})
				return
			case 'copy-reply': {
				const text = lastReplyText(state.messages)
				if (text === undefined) return
				void act(() => copyToClipboard(text, 'Reply copied.'))
				return
			}
			case 'copy-markdown':
				if (!api.conversationMarkdown) return
				void act(async () => {
					const result = await api.conversationMarkdown?.(view.id)
					if (!result) return
					if (result.truncated)
						throw new Error(
							'This conversation is larger than the 4 MiB copy limit, so nothing was copied.',
						)
					await copyToClipboard(result.markdown, 'Conversation copied as Markdown.')
				})
				return
			case 'copy-id':
				void act(() => copyToClipboard(view.id, 'Conversation ID copied.'))
				return
			case 'copy-path': {
				const owner = projects.find((item) => item.id === view.projectId)
				if (owner?.path) void act(() => copyToClipboard(owner.path, 'Project path copied.'))
				return
			}
			case 'open-editor':
			case 'open-file-manager':
			case 'open-terminal': {
				if (!api.openProjectPath) return
				const target =
					id === 'open-editor' ? 'editor' : id === 'open-file-manager' ? 'file-manager' : 'terminal'
				// The empty path is the project folder itself.
				void act(() => api.openProjectPath?.(view.projectId, '', target) ?? Promise.resolve())
				return
			}
			case 'move-right':
				if (group.tabs.length > 1) onSplit(group.id, view.id, 'right')
				return
			case 'move-window':
				onDetach(group.id, view.id)
				return
			case 'archive':
				requestConversationRemoval(view, trigger)
				return
		}
	}
	const tabActions: ConversationTabActions = {
		mac: macPlatform,
		input: conversationActionInput,
		run: runConversationAction,
	}
	const sidebarRowActions: ThreadRowActions = {
		mac: macPlatform,
		input: conversationActionInput,
		run: (id, view, trigger) =>
			id === 'archive'
				? archiveConversationNow(view, trigger)
				: runConversationAction(id, view, trigger),
		archive: api.removeConversation ? archiveConversationNow : undefined,
		pin: api.setConversationPinned ? (view) => runConversationAction('pin', view, null) : undefined,
		loadGit: api.projectGit,
	}
	// The key handler is registered once per state change; it reads the latest runner here.
	// Returns whether the chord meant something here, so an inert chord stays the browser's.
	const shortcutRunner = useRef<(id: ConversationActionId) => boolean>(() => false)
	shortcutRunner.current = (id) => {
		const view = conversations.find((item) => item.id === sessionId)
		if (!view || palConversation || loading || restoringTabs || railSection !== null) return false
		const input = conversationActionInput(view)
		const entry = conversationActionGroups(input)
			.flat()
			.find((item) => item.id === id)
		if (!entry) return false
		if (entry.reason) {
			notify(entry.reason, { tone: 'warning' })
			return true
		}
		runConversationAction(
			id,
			view,
			document.activeElement instanceof HTMLElement ? document.activeElement : null,
		)
		return true
	}
	const openPal = async (value: PalView) => {
		const remembered = warmPalConversation(
			value.id,
			projects,
			conversations,
			context.current.group.tabs,
			(view) =>
				palCatalogueActivity.current.current(value.id) &&
				Boolean(warmSessions.current.read(view.id, view.projectId)),
		)
		if (remembered) {
			setLoading(false)
			return openConversation(remembered)
		}
		// Knowing the latest target does not admit a closed tab. Canonical opening
		// and a fresh history/metadata read still run, without rediscovering the Pal.
		const target = palCatalogueActivity.current.confirmedCurrent(value.id)
			? latestPalConversation(value.id, projects, conversations)
			: undefined
		if (target) {
			setLoading(false)
			return openConversation(target)
		}
		abandonTabRestore()
		const generation = ++navigation.current
		setPalScreen(undefined)
		setLoading(true)
		let loadingGeneration = generation
		try {
			const activity = palCatalogueActivity.current.ticket(value.id)
			const opened = await api.openPal(value.id)
			if (removedPals.current.has(value.id)) throw new Error('This Pal has been deleted.')
			palCatalogueActivity.current.confirm(value.id, activity)
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
			const opening = openConversation(latest)
			loadingGeneration = navigation.current
			await opening
		} finally {
			if (loadingGeneration === navigation.current) setLoading(false)
		}
	}
	/** The open conversation when nothing was ever said, typed or run in it; otherwise nothing. */
	const untouchedConversation = (): string | undefined => {
		const view = conversations.find((item) => item.id === sessionId)
		const owned = threads[sessionId]
		if (
			!view ||
			view.palId ||
			view.title !== 'New conversation' ||
			owned?.messages.length ||
			owned?.running ||
			owned?.queued.length ||
			owned?.permissions.length ||
			draftsRef.current[sessionId]?.trim()
		)
			return undefined
		return view.id
	}
	/**
	 * Starts the new Pal's own host and shows it. The Pal already exists: a slow or failed start never
	 * undoes it, never holds the saving state, and is cancelled or retried from the notice.
	 */
	const beginOpeningPal = async (saved: PalView, blank?: string) => {
		const run = ++openingRun.current
		setPalOpening({ palId: saved.id, name: saved.name, startedAt: Date.now() })
		try {
			await openPal(saved)
		} catch (failure) {
			if (run === openingRun.current)
				setPalOpening({
					palId: saved.id,
					name: saved.name,
					startedAt: Date.now(),
					failure: errorText(failure),
				})
			return
		}
		if (run === openingRun.current) setPalOpening(undefined)
		// An empty, untouched "New conversation" would stay open beside the new Pal for no reason.
		if (blank && context.current.group.tabs.includes(blank))
			await onAction({
				kind: 'close',
				groupId: context.current.group.id,
				tabId: blank,
			}).catch(() => undefined)
	}
	// A start that failed is told on the Pals page; once the person is elsewhere it is old news.
	useEffect(() => {
		if (!palsPage && palOpening?.failure) setPalOpening(undefined)
	}, [palsPage, palOpening])
	const cancelOpeningPal = () => {
		openingRun.current += 1
		navigation.current += 1
		setLoading(false)
		setPalOpening(undefined)
	}
	const savePal = (value: PalCreateInput, id?: string) =>
		new Promise<void>((resolve) => {
			// Synchronous: a second submit before the next render must not start a second save.
			const started = savingPal.current.run(async () => {
				try {
					await saveOnce(value, id)
				} finally {
					resolve()
				}
			})
			if (!started) resolve()
		})
	const saveOnce = async (value: PalCreateInput, id?: string) => {
		setPalsSaving(true)
		setPalsError('')
		let created: PalView | undefined
		let blank: string | undefined
		try {
			const editing = editingPal
			if (id && (!editing || editing.id !== id))
				throw new Error('Open this Pal’s customization again.')
			const others = pals.filter((item) => item.id !== id).map((item) => item.name)
			if (isDuplicatePalName(value.name, others))
				throw new Error(duplicatePalNameMessage(value.name, others))
			const saved = id
				? await api.updatePal(id, editing?.revision ?? 0, value)
				: await api.createPal(value)
			palCatalogueActivity.current.changed(saved.id)
			upsertPal(saved)
			setEditingPal(undefined)
			setCreatingPal(false)
			// Editing stays in the current conversation; its model choice is local.
			if (!id) {
				created = saved
				blank = untouchedConversation()
			}
		} catch (failure) {
			setPalsError(errorText(failure))
		} finally {
			setPalsSaving(false)
		}
		// After the saving state is released, so the dialog and every control stay usable meanwhile.
		if (created) void beginOpeningPal(created, blank)
	}
	useEffect(() => {
		if (!pal?.id || palsPage || pageOpen || project?.status !== 'ready') return
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
		pageOpen,
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
					railSection === 'plugins' || railSection === 'settings'
						? railSection
						: palsPage
							? 'pals'
							: computerPage
								? 'computer'
								: 'chat',
			})
	}, [focused, railSection, palsPage, computerPage, onShellState])
	const savePresentation = useCallback(() => {
		if (!sessionId || !context.current.group.tabs.includes(sessionId)) return
		const disclosureView = workDisclosureViewRef.current
		const pendingPosition = pendingPresentationScroll.current
		const position = pendingPosition?.sessionId === sessionId ? pendingPosition : undefined
		const workDisclosures =
			!palConversation &&
			disclosureView.sessionId === sessionId &&
			Object.keys(disclosureView.choices).length
				? disclosureView.choices
				: undefined
		// A transcript that is hidden or detached (a window closing, a pane being moved) reads as
		// scrolled to the top; that is not where the reader was, so the saved position is kept.
		const node = transcript.current
		const measured = Boolean(node?.isConnected && node.clientHeight > 0)
		const kept = measured ? null : readWorkspacePresentation(localStorage, sessionId)
		writeWorkspacePresentation(localStorage, sessionId, {
			palScreen,
			computerChat,
			floatingChatMinimized,
			palProfileOpen,
			computerProfileOpen,
			jobsOpen: detailsOpen,
			panelTab: shownPanelTab?.kind === 'changes' ? 'changes' : 'jobs',
			panelExpanded,
			follow: position?.follow ?? kept?.follow ?? follow.current,
			scrollTop:
				position?.scrollTop ?? (measured ? (node?.scrollTop ?? 0) : (kept?.scrollTop ?? 0)),
			workDisclosures,
		})
	}, [
		sessionId,
		palScreen,
		computerChat,
		floatingChatMinimized,
		palProfileOpen,
		computerProfileOpen,
		detailsOpen,
		shownPanelTab?.kind,
		panelExpanded,
		palConversation,
	])
	writePresentation.current = savePresentation
	const onWorkDisclosureChange = useCallback(
		(owner: string, key: string, open: boolean) => {
			// A conversation started in this window has no saved view yet: it begins with no choices
			// rather than ignoring the click, or its work summary could not be opened until reopened.
			const held = workDisclosureViewRef.current
			const current = held.sessionId === owner ? held : { sessionId: owner, choices: {} }
			if (
				owner !== activeSession.current ||
				palConversation ||
				context.current.frozen ||
				current.choices[key] === open
			)
				return
			const next = {
				sessionId: owner,
				choices: chooseWorkDisclosure(current.choices, key, open),
			}
			if (next.choices === current.choices) return
			if (pendingPresentationScroll.current?.sessionId === owner)
				pendingPresentationScroll.current = null
			workDisclosureViewRef.current = next
			setWorkDisclosureView(next)
			try {
				writePresentation.current()
			} catch (failure) {
				setError(errorText(failure))
			}
		},
		[palConversation],
	)
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

	const togglePalPaused = (value: PalView) =>
		void act(async () => {
			upsertPal(await api.updatePal(value.id, value.revision, { paused: !value.paused }))
		})
	const openPalInbox = (palName: string) => {
		const matches = pals.filter((item) => item.name === palName)
		const target = matches[0]
		if (!target) return
		if (matches.length > 1) {
			notify(`More than one Pal is called ${palName}. Open the one you meant from the sidebar.`, {
				tone: 'warning',
			})
			return
		}
		setPendingPalInbox(target.id)
		void act(() => openPal(target))
	}

	// Only the newest message to a Pal in the open conversation asks to start it.
	const newestPalSends = useMemo(() => {
		const newest = new Map<string, string>()
		for (const send of palMessageSends(thread.timeline, thread)) newest.set(send.name, send.id)
		return newest
	}, [thread])
	// Rebuilt each render: only the few lines that say "sent to a Pal" read it.
	const palStartControls = ((): PalStartControls | undefined => {
		if (!palStarts.enabled) return undefined
		const byName = (name: string) => {
			const matches = pals.filter((item) => item.name === name)
			return matches.length === 1 ? matches[0] : undefined
		}
		return {
			card: (name, sendId) => {
				const target = byName(name)
				if (!target || newestPalSends.get(name) !== sendId) return { kind: 'none' }
				return palStartCard(name, target.paused, palStarts.entries[target.id])
			},
			onStart: (name) => {
				const target = byName(name)
				if (target) void palStarts.start(target.id)
			},
			onNotNow: (name) => {
				const target = byName(name)
				if (target) palStarts.dismiss(target.id)
			},
			onOpenPal: (name) => {
				const target = byName(name)
				if (!target) return
				// The run wrote to a conversation this window has not listed yet.
				palCatalogueActivity.current.changed(target.id)
				void act(() => openPal(target))
			},
			onResume: (name) => {
				const target = byName(name)
				if (target) {
					togglePalPaused(target)
					void palStarts.refresh(target.id)
				}
			},
		}
	})()

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
					notice: presentComputerNotice(
						palComputer?.notice ??
							(palComputer?.status === 'stopped'
								? 'Start your Pal’s local computer to use apps and tools.'
								: undefined),
					),
				},
				hostComputer: humanComputer,
				activity: palRecentActivity(thread),
				outputs: changes
					? [
							{
								id: sessionId,
								label: `${changes} changed ${changes === 1 ? 'file' : 'files'}`,
								content: (
									<ChangesPanel
										tools={thread.tools}
										dark={
											appearance === 'dark' ||
											(appearance === 'system' &&
												window.matchMedia('(prefers-color-scheme: dark)').matches)
										}
									/>
								),
							},
						]
					: [],
				tasks: thread,
				onCustomize: () => showPalEditor(pal),
				onCommunication: sessionId
					? (trigger) => {
							communicationTrigger.current = trigger
							setCommunicationOwner({ palId: pal.id, sessionId })
						}
					: undefined,
				customizeDisabled: palBusy || palsSaving,
				onPause: () => togglePalPaused(pal),
				pauseDisabled: palBusy || palsSaving,
				waiting: palWaitingLine(pal.name, pal.paused, palStarts.entries[pal.id]),
				onWaitingAction: (action) => {
					if (action === 'resume') {
						togglePalPaused(pal)
						void palStarts.refresh(pal.id)
					} else void palStarts.start(pal.id)
				},
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
	/** Settings is a page like Plugins; `settings/<section>` is its route and a search result adds a target. */
	const openSettings = (section?: SettingsSection, focusId?: string) => {
		abandonTabRestore()
		navigation.current += 1
		setPalScreen(undefined)
		setPluginSelection(undefined)
		setPalsPage(false)
		if (section) setSettingsSection(section)
		setSettingsFocus(focusId)
		setRailSection('settings')
		setJobsOpen(false)
		setSideOpen(false)
	}
	const openSettingsRef = useRef(openSettings)
	openSettingsRef.current = openSettings
	// A toast about a program that is behind opens Settings ▸ Updates in the pane that was focused last.
	const engineUpdates = useEngineUpdates()
	useEffect(
		() =>
			focused
				? engineUpdates?.registerOpenUpdates(() => openSettingsRef.current('updates'))
				: undefined,
		[focused, engineUpdates?.registerOpenUpdates],
	)
	const changeDraft = (target: string, value: string) => {
		if (editingQueue.current.has(target)) return
		draftEditRevisions.current.set(target, (draftEditRevisions.current.get(target) ?? 0) + 1)
		draftsRef.current[target] = value
		setDrafts((all) => ({ ...all, [target]: value }))
		void api.saveDraft(target, value).catch((failure) => setError(errorText(failure)))
	}
	const editQueued = useCallback(
		async (itemId?: string) => {
			const target = sessionId
			if (loading || restoringTabs || !target || editingQueue.current.has(target)) return
			if ((draftsRef.current[target] ?? '').length > 0 || attached.get(target).length > 0)
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
		[
			sessionId,
			loading,
			restoringTabs,
			attached.reload,
			attached.get,
			savedSettings.get,
			savedSettings.save,
			api,
			pal,
		],
	)
	// What a stopped reply says: plain words with a next step; the runtime's own text sits behind Details.
	const failedProviderLabel = activeProviders.available.find(
		(item) => item.id === choice.provider,
	)?.label
	// "Continue without this reply" failed: the conversation itself cannot take the message back,
	// so the same words offer to carry it to a new conversation instead.
	const baseFailures = [
		...(thread.error ? [describeFailure(thread.error, failedProviderLabel)] : []),
		...(thread.retryNotice ? [describeBlockedRetry(thread.retryNotice)] : []),
	]
	const replyFailures = (
		thread.retry && thread.retryUnknownUsage
			? withUnknownUsage(baseFailures, thread.retryUnknownUsage)
			: baseFailures
	).map((failure) =>
		continueFailed === sessionId && failure.actions.includes('continue')
			? { ...failure, actions: [...failure.actions, 'copy-to-new' as const] }
			: failure,
	)
	const putMessageBack = (text: string) => {
		draftsRef.current[sessionId] = text
		setDrafts((all) => ({ ...all, [sessionId]: text }))
		requestAnimationFrame(() => input.current?.focus())
	}
	const continueWithoutReply = async () => {
		const from = sessionId
		if (!api.continueWithoutReply || !from) return
		try {
			const restored = await api.continueWithoutReply(from)
			setContinueFailed('')
			if (activeSession.current === from) putMessageBack(restored.text)
			await attached.reload(from)
		} catch (failure) {
			setContinueFailed(from)
			throw failure
		}
	}
	const copyMessageToNewConversation = async () => {
		const from = sessionId
		if (!api.reopenLastMessage || !from || !project) return
		const restored = await api.reopenLastMessage(from)
		const view = await api.newConversation(project.id)
		setConversations((all) => [view, ...all.filter((item) => item.id !== view.id)])
		setThreads((all) => ({ ...all, [view.id]: emptyThread() }))
		setOpenTabIds((all) => (all.includes(view.id) ? all : [...all, view.id]))
		draftsRef.current[view.id] = restored.text
		setDrafts((all) => ({ ...all, [view.id]: restored.text }))
		await api.saveDraft(view.id, restored.text)
		if (restored.attachments.length > 0) {
			await api.moveAttachments(from, view.id)
			await attached.reload(view.id)
		}
		await api.saveDraft(from, '')
		draftsRef.current[from] = ''
		setDrafts((all) => ({ ...all, [from]: '' }))
		setContinueFailed('')
		setSessionId(view.id)
		requestAnimationFrame(() => input.current?.focus())
	}
	const send = async (delivery: 'current' | 'queue' = 'current') => {
		if (context.current.frozen) return
		if (cliSurface) {
			await openEngineTerminal()
			return
		}
		if (thread.retry || thread.retryNotice || thread.reason === 'paused')
			throw new Error(
				thread.retryNotice
					? describeBlockedRetry(thread.retryNotice).text
					: 'The last reply stopped early. Choose Try again, or Continue without this reply. Your message is kept.',
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
			// Free keyless models are offered, not a connection; the composer says what to do.
			usableProviders(activeProviders).length === 0 ||
			!attached.loaded ||
			savedSettings.loading ||
			harnessBusy ||
			sendingRef.current.has(draftOwner) ||
			attached.isBusy(draftOwner)
		)
			return
		const owner = draftOwner
		const prompt = draft
		const attachmentIds = attached.get(owner).map((file) => file.id)
		const options = {
			...settings,
			effort: effortToSend(capabilities, settings.effort),
			attachmentIds,
		}
		const originalSettings = savedSettings.get(owner)
		const route = { ...choice }
		const generation = navigation.current
		let target = sessionId
		let targetEditRevision = draftEditRevisions.current.get(owner) ?? 0
		let submitted = false
		sendingRef.current.add(owner)
		setSending((all) => ({ ...all, [owner]: true }))
		try {
			if (!target) {
				const view = await api.newConversation(project.id)
				target = view.id
				targetEditRevision = draftEditRevisions.current.get(target) ?? 0
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
			const admission = {
				prompt,
				editRevision: targetEditRevision,
				restored: false,
				started: false,
			}
			const currentSender = api.sendCurrent
			const usingCurrent =
				delivery === 'current' &&
				thread.running &&
				thread.liveInputSupported &&
				attachmentIds.length === 0 &&
				!palConversation &&
				!!currentSender
			if (!thread.running || usingCurrent) draftAdmissions.current.set(target, admission)
			if (!thread.running) await api.selectProvider(target, route.provider, route.model)
			if (usingCurrent && currentSender) {
				const result = await currentSender(target, prompt, options)
				if (result === 'queued') draftAdmissions.current.delete(target)
			} else await api.send(target, prompt, options)
			submitted = true
			attached.consume(target, attachmentIds)
			// A fast failure may settle before this admission reply arrives. Read main's
			// draft after consumption as well as on settlement, so retry files stay visible.
			void attached.reload(target).catch((failure) => {
				if (
					mounted.current &&
					activeSession.current === target &&
					navigation.current === generation
				)
					setError(errorText(failure))
			})
			if (
				draftsRef.current[target] === prompt &&
				!admission.restored &&
				admission.editRevision === (draftEditRevisions.current.get(target) ?? 0)
			) {
				draftsRef.current[target] = ''
				setDrafts((all) => ({ ...all, [target]: '' }))
			}
			if (activeSession.current === target) follow.current = true
		} finally {
			if (!submitted) draftAdmissions.current.delete(target)
			sendingRef.current.delete(owner)
			sendingRef.current.delete(target)
			setSending((all) => ({ ...all, [owner]: false, [target]: false }))
		}
	}

	/** Asks the newest reply's question again, exactly as it was typed. */
	const retryable = retryableReply(thread)
	const retryReply = async (prompt: string) => {
		if (
			context.current.frozen ||
			thread.running ||
			loading ||
			restoringTabs ||
			!sessionId ||
			!project?.trusted ||
			project.status !== 'ready' ||
			!choice.provider ||
			!providerReady
		)
			return
		const route = { ...choice }
		await api.selectProvider(sessionId, route.provider, route.model)
		await api.send(sessionId, prompt, {
			...settings,
			effort: effortToSend(capabilities, settings.effort),
			attachmentIds: [],
		})
		follow.current = true
	}

	// The pane's strip in order (terminals included) and the tab in front.
	const stripIds = terminalGroup ? terminalGroup.order : group.tabs
	const frontTabId = activeTerminal?.id ?? (group.activeTabId || sessionId)
	const showTab = (id: string) => {
		const activate = () =>
			void onAction({ kind: 'activate', groupId: group.id, tabId: id }).catch((failure) =>
				setError(errorText(failure)),
			)
		if (terminalById.has(id)) return activate()
		const view = conversations.find((item) => item.id === id)
		if (!view?.projectId) return
		if (activeTerminal) activate()
		else void act(() => openConversation(view))
	}
	// Returns whether the chord meant something here, so an inert chord stays the browser's.
	const runTabChord = (chord: TabChord): boolean => {
		if (context.current.frozen || loading) return false
		const at = stripIds.indexOf(frontTabId)
		switch (chord.kind) {
			case 'close':
				if (!frontTabId) return false
				void onAction({ kind: 'close', groupId: group.id, tabId: frontTabId }).catch((failure) =>
					setError(errorText(failure)),
				)
				return true
			case 'next':
			case 'previous': {
				if (stripIds.length === 0) return false
				const step = chord.kind === 'next' ? 1 : -1
				const target = stripIds[(Math.max(at, 0) + step + stripIds.length) % stripIds.length]
				if (target && target !== frontTabId) showTab(target)
				return true
			}
			case 'select': {
				const index = selectedTabIndex(chord.number, stripIds.length)
				const target = index === undefined ? undefined : stripIds[index]
				if (target && target !== frontTabId) showTab(target)
				return true
			}
			case 'move': {
				const to = at < 0 ? undefined : movedTabIndex(at, chord.delta, stripIds.length)
				if (at < 0 || to === undefined) return true
				// The drop index counts the tab being moved, as a drop on the far half of a neighbour does.
				void onAction({
					kind: 'move',
					tabId: frontTabId,
					sourceGroupId: group.id,
					targetWindowId: windowId,
					targetGroupId: group.id,
					position: 'center',
					index: chord.delta > 0 ? at + 2 : at - 1,
				}).catch((failure) => setError(errorText(failure)))
				return true
			}
			case 'split-right':
				if (!terminalReady) return false
				newTabMenuAction('terminal-right')
				return true
		}
	}
	const runTabChordRef = useRef(runTabChord)
	runTabChordRef.current = runTabChord

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
			if (
				(event.metaKey || event.ctrlKey) &&
				event.shiftKey &&
				!event.altKey &&
				(event.code === 'Backquote' || event.key === '`' || event.key === '~')
			) {
				event.preventDefault()
				void act(() => openShellRef.current())
				return
			}
			const tabAction = tabChord(event, { mac: macPlatform })
			if (tabAction && runTabChordRef.current(tabAction)) {
				event.preventDefault()
				return
			}
			if (
				(event.metaKey || event.ctrlKey) &&
				!event.altKey &&
				!event.shiftKey &&
				event.key === ','
			) {
				event.preventDefault()
				openSettingsRef.current()
				return
			}
			if (event.key === 'Escape') {
				if (computerPage) {
					showPalChat()
					return
				}
				// An expanded panel is left with its own buttons, not by a key aimed at something else.
				if (detailsOpen && panelExpanded) return
				if (sideOpen || detailsOpen) {
					setSideOpen(false)
					if (detailsOpen) closeDetails()
				} else if (thread.running && !loading && !restoringTabs && !pageOpen)
					void act(() => api.cancel(sessionId))
				return
			}
			// Dialogs own the keyboard, and a chord only means an action when it is not AltGr or IME input.
			const shortcut =
				sessionId && !renamingConversation && !removingConversation
					? conversationShortcut(event, macPlatform)
					: null
			if (shortcut && shortcutRunner.current(shortcut)) {
				event.preventDefault()
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
			if (event.altKey && event.key === 'ArrowUp' && sessionId && !pageOpen) {
				event.preventDefault()
				void act(() => editQueued())
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [
		sideOpen,
		detailsOpen,
		panelExpanded,
		sessionId,
		thread.running,
		restoringTabs,
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
		pageOpen,
		computerPage,
		showPalChat,
		api,
		renamingConversation,
		removingConversation,
		macPlatform,
	])
	const shortcutModifier = /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'
	// Conversations that were never written in are left out, and each one is listed once: the
	// newest few as "Recent", the rest under "Conversations".
	const paletteConversations = [
		...new Map(
			conversations
				.filter(
					(view) =>
						projects.some((item) => item.id === view.projectId) &&
						(view.palId ||
							view.title !== EMPTY_CONVERSATION_TITLE ||
							threads[view.id]?.messages.length),
				)
				.map((view) => [view.id, view] as const),
		).values(),
	].sort(compareConversationRecency)
	const frontConversation = conversations.find((item) => item.id === sessionId)
	const conversationChordReady =
		Boolean(frontConversation) && !palConversation && !loading && !restoringTabs
	const commandItems: CommandPaletteItem[] = [
		...paletteConversations.map((view, index) => {
			const owner = projects.find((item) => item.id === view.projectId)
			return {
				id: `conversation:${view.id}`,
				label: view.title,
				group: index < RECENT_PALETTE_CONVERSATIONS ? 'Recent' : 'Conversations',
				meta: owner?.name,
				keywords: [owner?.name ?? '', view.id],
				disabled: !owner?.trusted || owner.status !== 'ready',
				onAction: () => void act(() => openConversation(view)),
			}
		}),
		{
			id: 'new-conversation',
			label: 'New conversation',
			group: 'Actions',
			icon: <SquarePenIcon aria-hidden="true" />,
			shortcut: [shortcutModifier, 'N'],
			disabled: loading,
			onAction: () => void act(newConversation),
		},
		{
			id: 'new-terminal',
			label: 'New terminal',
			group: 'Actions',
			icon: <TerminalIcon aria-hidden="true" />,
			shortcut: [shortcutModifier, 'Shift', '`'],
			keywords: ['shell', 'command line', 'console', 'cli'],
			disabled: loading || !terminalReady,
			onAction: () => void act(openShellTerminal),
		},
		{
			id: 'terminal-right',
			label: 'New terminal to the right',
			group: 'Actions',
			icon: <SplitRightIcon aria-hidden="true" />,
			shortcut: [shortcutModifier, 'Shift', '\\'],
			keywords: ['split', 'beside', 'side by side', 'shell'],
			disabled: loading || !terminalReady,
			onAction: () => newTabMenuAction('terminal-right'),
		},
		{
			id: 'terminal-below',
			label: 'New terminal below',
			group: 'Actions',
			icon: <SplitDownIcon aria-hidden="true" />,
			keywords: ['split', 'under', 'shell'],
			disabled: loading || !terminalReady,
			onAction: () => newTabMenuAction('terminal-below'),
		},
		{
			id: 'conversation-right',
			label: 'New conversation to the right',
			group: 'Actions',
			icon: <SplitRightIcon aria-hidden="true" />,
			keywords: ['split', 'beside', 'side by side'],
			disabled: loading,
			onAction: () => newTabMenuAction('conversation-right'),
		},
		{
			id: 'conversation-below',
			label: 'New conversation below',
			group: 'Actions',
			icon: <SplitDownIcon aria-hidden="true" />,
			keywords: ['split', 'under'],
			disabled: loading,
			onAction: () => newTabMenuAction('conversation-below'),
		},
		...(activeTerminal
			? [
					{
						id: 'find-in-terminal',
						label: 'Find in terminal',
						group: 'Actions',
						icon: <SearchIcon aria-hidden="true" />,
						shortcut: [shortcutModifier, 'F'],
						keywords: ['search', 'terminal'],
						onAction: () => openTerminalFind(activeTerminal.id),
					},
				]
			: []),
		{
			id: 'rename-conversation',
			label: 'Rename conversation',
			group: 'Actions',
			shortcut: [shortcutModifier, 'Alt', 'R'],
			disabled: !conversationChordReady,
			onAction: () => void shortcutRunner.current('rename'),
		},
		{
			id: 'pin-conversation',
			label: frontConversation?.pinned ? 'Unpin conversation' : 'Pin conversation',
			group: 'Actions',
			shortcut: [shortcutModifier, 'Alt', 'P'],
			disabled: !conversationChordReady,
			onAction: () => void shortcutRunner.current('pin'),
		},
		{
			id: 'archive-conversation',
			label: 'Archive conversation',
			group: 'Actions',
			shortcut: [shortcutModifier, 'Shift', 'A'],
			disabled: !conversationChordReady,
			onAction: () => void shortcutRunner.current('archive'),
		},
		...(api.archivedConversations
			? [
					{
						id: 'archived-conversations',
						label: 'Archived conversations',
						group: 'Actions',
						icon: <ArchiveIcon aria-hidden="true" />,
						keywords: ['restore', 'archive', 'old'],
						onAction: () => setArchivedOpen(true),
					},
				]
			: []),
		{
			id: 'close-tab',
			label: 'Close tab',
			group: 'Tabs',
			shortcut: [shortcutModifier, 'W'],
			meta: 'In a terminal: Ctrl+F4',
			keywords: ['tab', 'close'],
			disabled: !frontTabId,
			onAction: () => void runTabChord({ kind: 'close' }),
		},
		{
			id: 'next-tab',
			label: 'Next tab',
			group: 'Tabs',
			shortcut: ['Ctrl', 'Tab'],
			meta: `${shortcutModifier}+1 to 9 picks a tab`,
			keywords: ['switch', 'tab'],
			disabled: stripIds.length < 2,
			onAction: () => void runTabChord({ kind: 'next' }),
		},
		{
			id: 'previous-tab',
			label: 'Previous tab',
			group: 'Tabs',
			shortcut: ['Ctrl', 'Shift', 'Tab'],
			keywords: ['switch', 'tab'],
			disabled: stripIds.length < 2,
			onAction: () => void runTabChord({ kind: 'previous' }),
		},
		{
			id: 'move-tab-left',
			label: 'Move tab left',
			group: 'Tabs',
			shortcut: ['Ctrl', 'Shift', 'PageUp'],
			keywords: ['reorder', 'tab'],
			disabled: stripIds.length < 2,
			onAction: () => void runTabChord({ kind: 'move', delta: -1 }),
		},
		{
			id: 'move-tab-right',
			label: 'Move tab right',
			group: 'Tabs',
			shortcut: ['Ctrl', 'Shift', 'PageDown'],
			keywords: ['reorder', 'tab'],
			disabled: stripIds.length < 2,
			onAction: () => void runTabChord({ kind: 'move', delta: 1 }),
		},
		{
			id: 'open-settings',
			label: 'Settings',
			group: 'Actions',
			icon: <SettingsIcon aria-hidden="true" />,
			shortcut: [shortcutModifier, ','],
			keywords: [
				'preferences',
				'options',
				'theme',
				'updates',
				'projects',
				settingsRoute('general'),
			],
			onAction: () => openSettings(),
		},
		{
			id: 'create-project',
			label: `Add project: ${START_FROM_SCRATCH_LABEL.toLowerCase()}`,
			group: 'Actions',
			icon: <FolderIcon aria-hidden="true" />,
			keywords: ['new project', 'folder', 'create'],
			disabled: loading,
			onAction: () => void act(createProject),
		},
		{
			id: 'open-project',
			label: `Add project: ${USE_EXISTING_FOLDER_LABEL.toLowerCase()}`,
			group: 'Actions',
			icon: <FolderIcon aria-hidden="true" />,
			shortcut: [shortcutModifier, 'O'],
			keywords: ['new project', 'open folder'],
			disabled: loading,
			onAction: () => void act(openProject),
		},
		...projects
			.filter((item) => !item.palId && !item.isChat && !item.missing)
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
					onDelete: api.deletePal ? () => requestPalDeletion(pal) : undefined,
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
			active={startAtHome ? '' : group.activeTabId || sessionId}
			busy={loading || harnessBusy || frozen}
			onRemove={api.removeConversation ? requestConversationRemoval : undefined}
			actions={tabActions}
			palNames={Object.fromEntries(pals.map((item) => [item.id, item.name]))}
			palAppearances={Object.fromEntries(pals.map((item) => [item.id, item.appearance]))}
			palWorkspace={palTabs}
			backgroundWork={backgroundWork}
			running={(id) => threads[id]?.running ?? false}
			onNew={() => void act(newConversation)}
			onSelect={(view) =>
				// A tab whose conversation the catalogue has not delivered yet names no project to open it in.
				!view.projectId
					? undefined
					: activeTerminal
						? // The conversation behind the terminal is already open; fronting its tab is a layout change.
							void onAction({ kind: 'activate', groupId: group.id, tabId: view.id }).catch(
								(failure) => setError(errorText(failure)),
							)
						: void act(() => openConversation(view))
			}
			terminals={
				terminalGroup
					? {
							tabs: stripTerminals,
							order: terminalGroup.order,
							activeId: activeTerminal?.id,
							onSelect: (tab) =>
								void onAction({ kind: 'activate', groupId: group.id, tabId: tab.id }).catch(
									(failure) => setError(errorText(failure)),
								),
							onClose: (tab) =>
								void onAction({ kind: 'close', groupId: group.id, tabId: tab.id }).catch(
									(failure) => setError(errorText(failure)),
								),
							onDetach: (tab, bounds) => onDetach(group.id, tab.id, bounds),
							onSplit:
								terminalGroup.order.length > 1
									? (tab, position) => onSplit(group.id, tab.id, position)
									: undefined,
							onNew: terminalReady ? () => void act(() => openShellTerminal()) : undefined,
						}
					: undefined
			}
			newMenu={{
				onAction: newTabMenuAction,
				terminalReason: terminalUnavailableReason({ bridge: Boolean(terminalBridge), project }),
			}}
			windowId={windowId}
			groupId={group.id}
			onDetach={(view, bounds) => onDetach(group.id, view.id, bounds)}
			onSplit={
				group.tabs.length > 1 ? (view, position) => onSplit(group.id, view.id, position) : undefined
			}
			onClose={(view) =>
				void onAction({
					kind: 'close',
					groupId: group.id,
					tabId: view.id,
				}).catch((failure) => setError(errorText(failure)))
			}
		/>
	)
	return (
		<PaneToasts focused={focused} pane={paneRoot}>
			{focused &&
				shell &&
				createPortal(
					<>
						{communicationOwner &&
							pal?.id === communicationOwner.palId &&
							sessionId === communicationOwner.sessionId && (
								<PalCommunicationDialog
									key={`${sessionId}:${pal.id}:${communicationOwner.tab ?? 'general'}`}
									api={api}
									sessionId={sessionId}
									pal={pal}
									tab={communicationOwner.tab}
									conversationTitle={(id) => conversations.find((item) => item.id === id)?.title}
									settings={{
										pal,
										disabled: palBusy || palsSaving,
										onCustomize: () => {
											setCommunicationOwner(undefined)
											showPalEditor(pal)
										},
										onTogglePause: () => {
											setCommunicationOwner(undefined)
											togglePalPaused(pal)
										},
										onDelete: api.deletePal
											? () => {
													setCommunicationOwner(undefined)
													requestPalDeletion(pal)
												}
											: undefined,
									}}
									onClose={() => setCommunicationOwner(undefined)}
									returnFocus={() =>
										communicationTrigger.current?.isConnected ? communicationTrigger.current : null
									}
								/>
							)}
						{(creatingPal || editingPal) && (
							<PalCustomizeDialog
								key={editingPal ? `${editingPal.id}:${editingPal.revision}` : 'new'}
								editing={editingPal}
								existingNames={pals
									.filter((item) => item.id !== editingPal?.id)
									.map((item) => item.name)}
								saving={palsSaving}
								error={palsError}
								model={draftPalModel}
								onModelChange={setDraftPalModel}
								onClose={() => {
									setCreatingPal(false)
									setEditingPal(undefined)
								}}
								onSave={savePal}
								onDelete={api.deletePal ? requestPalDeletion : undefined}
								loadProviders={api.palProviders}
								loadModels={api.palModels}
							/>
						)}
						{folderAccess &&
							(() => {
								const target = folderAccess.pending
									? { id: folderAccess.projectId, ...folderAccess.pending }
									: projects.find((item) => item.id === folderAccess.projectId)
								if (!target) return null
								return (
									<FolderAccessDialog
										key={`folder-access:${target.id}:${folderAccess.broad ? 'broad' : folderAccess.risky ? 'risky' : 'review'}`}
										name={target.name}
										path={target.path}
										broad={folderAccess.broad?.kind}
										risky={folderAccess.risky?.found}
										details={folderAccess.risky?.details}
										changed={
											'settingsChanged' in target && !folderAccess.risky && !folderAccess.broad
												? target.settingsChanged
												: undefined
										}
										onClose={() => setFolderAccess(undefined)}
										returnFocus={() => document.querySelector<HTMLElement>('.welcome .primary')}
										onCancel={() => {
											const choose = Boolean(folderAccess.broad)
											setFolderAccess(undefined)
											if (choose) void act(openProject)
										}}
										onConfirm={async () => {
											// Confirming a known folder is consent the renderer captured: the person
											// already added it. A broad folder needs main's token; main answers an
											// unproven broad folder with a token, and this dialog asks again.
											if (folderAccess.pending) {
												const proof = folderAccess.broad?.token ?? folderAccess.risky?.token
												if (!proof || !api.trustFolder)
													throw new Error('Restart the desktop app, then choose the folder again.')
												const added = await api.trustFolder(proof)
												setFolderAccess(undefined)
												await landOnProject(added, ++navigation.current)
												return
											}
											const token = folderAccess.broad?.token ?? folderAccess.risky?.token
											const result = await api.trustProject(target.id, token)
											updateProject(result)
											setFolderAccess(
												result.broadFolder
													? { projectId: result.id, broad: result.broadFolder }
													: result.riskySettings
														? { projectId: result.id, risky: result.riskySettings }
														: undefined,
											)
										}}
									/>
								)
							})()}
						{deletingPal && (
							<ConfirmRemovalDialog
								key={`delete-pal:${deletingPal.id}:${deletingPal.revision}`}
								title={`Delete ${deletingPal.name}?`}
								description={palDeletionCopy(deletingPal).description}
								details={palDeletionCopy(deletingPal).details}
								actionLabel="Delete Pal"
								sideAction={
									api.openPalFolder
										? {
												label: 'Open folder',
												run: () =>
													(api.openPalFolder as (id: string) => Promise<void>)(deletingPal.id),
											}
										: undefined
								}
								onClose={() => setDeletingPal(undefined)}
								returnFocus={removalReturnFocus}
								onConfirm={() =>
									confirmedRemoval(async () => {
										if (!api.deletePal) throw new Error('Pal deletion is unavailable.')
										const result = await api.deletePal(deletingPal.id, deletingPal.revision)
										if (result.id !== deletingPal.id || result.deleted !== true)
											throw new Error('Pal deletion was not confirmed. Try again.')
									})
								}
							/>
						)}
						{undoingTurn && api.undoPreview && api.undoTurn && (
							<UndoDialog
								key={`undo:${undoingTurn.sessionId}:${undoingTurn.turnId}`}
								queued={threads[undoingTurn.sessionId]?.queued.length ?? 0}
								onClose={() => setUndoingTurn(undefined)}
								returnFocus={() => input.current}
								loadPreview={(options) =>
									(api.undoPreview as NonNullable<typeof api.undoPreview>)(
										undoingTurn.sessionId,
										undoingTurn.turnId,
										options,
									)
								}
								apply={async (planToken, options) => {
									if (context.current.frozen)
										throw new Error('Wait for this conversation to finish moving.')
									const result = await (api.undoTurn as NonNullable<typeof api.undoTurn>)(
										undoingTurn.sessionId,
										undoingTurn.turnId,
										planToken,
										options,
									)
									// The files moved: the open file, the tree and the Changes view read the disk again.
									if (result.status !== 'plan-changed') {
										setFilesRefresh((value) => value + 1)
										const summary = undoNotice(result)
										notify(summary.text, {
											tone: summary.tone,
											action: {
												label: 'Show',
												onClick: () => {
													setChangesFilter(undefined)
													showPanelTab('changes')
													setJobsOpen(true)
												},
											},
										})
									}
									return result
								}}
							/>
						)}
						{renamingProject && (
							<RenameConversationDialog
								key={`rename-project:${renamingProject.id}`}
								heading="Rename project"
								description="This changes the name Namzu shows. The folder keeps its name. Leave the name empty to show the folder name."
								fieldLabel="Project name"
								maxLength={80}
								initialTitle={renamingProject.name}
								onClose={() => setRenamingProject(undefined)}
								returnFocus={() =>
									projectRenameTrigger.current?.isConnected
										? projectRenameTrigger.current
										: document.querySelector<HTMLElement>('.sidebar-new-conversation')
								}
								onSave={async (name) => {
									if (context.current.frozen)
										throw new Error('Wait for this conversation to finish moving.')
									if (!api.renameProject) throw new Error('Renaming a project is unavailable.')
									const renamed = await api.renameProject(renamingProject.id, name)
									setProjects((items) =>
										items.map((row) => (row.id === renamed.id ? renamed : row)),
									)
								}}
							/>
						)}
						{renamingConversation && (
							<RenameConversationDialog
								key={`rename-conversation:${renamingConversation.id}`}
								initialTitle={renamingConversation.title}
								onClose={() => setRenamingConversation(undefined)}
								returnFocus={() =>
									renameTrigger.current?.isConnected ? renameTrigger.current : input.current
								}
								onSave={async (title) => {
									if (context.current.frozen)
										throw new Error('Wait for this conversation to finish moving.')
									if (!api.renameConversation) throw new Error('Renaming is unavailable.')
									upsertConversation(await api.renameConversation(renamingConversation.id, title))
								}}
							/>
						)}
						{archivedOpen && api.archivedConversations && (
							<ArchivedConversationsDialog
								key="archived"
								api={api}
								projects={projects
									.filter((item) => !item.palId && !item.isChat)
									.map((item) => ({ id: item.id, name: item.name }))}
								onClose={() => setArchivedOpen(false)}
								returnFocus={() => detailsTrigger.current ?? input.current}
								onRestored={(view) => {
									unblockRestoredConversation(view.id)
									upsertConversation(view)
								}}
							/>
						)}
						{removingConversation && (
							<ConfirmRemovalDialog
								key={`remove-conversation:${removingConversation.id}`}
								title="Archive this conversation?"
								description="It leaves your sidebar. Its history stays saved on this computer."
								actionLabel="Archive"
								pendingLabel="Archiving…"
								onClose={() => setRemovingConversation(undefined)}
								returnFocus={removalReturnFocus}
								onConfirm={() => confirmedRemoval(() => archiveConversation(removingConversation))}
							/>
						)}

						{removingProject &&
							(() => {
								const copy = projectRemovalCopy(removingProject)
								return (
									<ConfirmRemovalDialog
										key={`remove-project:${removingProject.id}`}
										title={copy.title}
										description={copy.description}
										actionLabel={copy.actionLabel}
										pendingLabel={copy.pendingLabel}
										onClose={() => setRemovingProject(undefined)}
										returnFocus={projectRemovalReturnFocus}
										onConfirm={() => confirmedRemoval(() => removeProject(removingProject))}
									/>
								)
							})()}
						<CommandPalette
							open={commandOpen}
							onOpenChange={setCommandOpen}
							triggerRef={commandTrigger}
							fallbackFocusRef={input}
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
							onCreateProject={() => void act(createProject)}
							onNewConversation={() => void act(newConversation)}
							newConversationDisabled={loading}
							onError={setError}
						/>
						<NavigationRail
							section={railSection ?? 'home'}
							onHome={() => {
								if (!loading) void act(newConversation)
							}}
							onSpaces={showSpaces}
							onSettings={() => openSettings()}
							update={update}
							onOpenUpdates={() => openSettings('updates')}
							onOpenProject={() => void act(openProject)}
							onCreateProject={() => void act(createProject)}
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
									unreadIds={unreadPals}
									creating={palsPage}
									openingId={palOpening && !palOpening.failure ? palOpening.palId : undefined}
									loading={palsLoading}
									failed={palsLoadFailed}
									onRetry={() => setPalsRetry((value) => value + 1)}
									onCreate={showPalOnboarding}
									onOpen={(value) => void act(() => openPal(value))}
								/>
							}
							conversations={conversations
								.filter(
									(view) =>
										view.palId ||
										view.title !== 'New conversation' ||
										threads[view.id]?.messages.length,
								)
								.sort(compareConversationOrder)}
							projectId={palsPage ? '' : projectId}
							sessionId={palsPage ? '' : sessionId}
							conversationCollection={conversationCollection}
							rowActions={sidebarRowActions}
							threads={threads}
							backgroundWork={backgroundWork}
							open={!pageOpen && sideOpen}
							onRemoveProject={api.removeProject ? requestProjectRemoval : undefined}
							onRenameProject={api.renameProject ? requestProjectRename : undefined}
							onLocateProject={
								api.locateProject ? (value) => void act(() => locateProject(value)) : undefined
							}
							onOpenProjectFolder={
								api.openProjectPath
									? (item) =>
											void act(
												() =>
													api.openProjectPath?.(item.id, '', 'file-manager') ?? Promise.resolve(),
											)
									: undefined
							}
							onOpenArchived={api.archivedConversations ? () => setArchivedOpen(true) : undefined}
							collapsed={sideCollapsed}
							opening={loading}
							onClose={() => setSideOpen(false)}
							onOpenProject={() => void act(openProject)}
							onCreateProject={() => void act(createProject)}
							onNewConversation={() => void act(newConversation)}
							onSearch={openCommands}
							onProject={(id) => void act(() => selectProject(id))}
							onConversation={(view, collection) =>
								void act(() => openConversation(view, collection))
							}
							terminals={terminalGroup?.tabs}
							activeTerminalId={activeTerminal?.id}
							onTerminal={(tab) =>
								void onAction({ kind: 'open', tabId: tab.id }).catch((failure) =>
									setError(errorText(failure)),
								)
							}
							onCloseTerminal={
								api.closeTerminal
									? (tab) =>
											void api
												.closeTerminal?.(tab.id)
												.catch((failure) => setError(errorText(failure)))
									: undefined
							}
						/>
						{railSection === 'settings' && (
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
									id="namzu-settings-sidebar"
									className={`sidebar plugins-navigation-sidebar settings-navigation-sidebar ${sideOpen ? 'open' : ''}`}
									inert={sideCollapsed && !sideOpen}
									aria-hidden={sideCollapsed && !sideOpen}
									aria-label="Settings"
								>
									<SettingsSidebar
										section={settingsSection}
										onSection={(section) => {
											setSettingsSection(section)
											setSettingsFocus(undefined)
											// A narrow window shows the list as an overlay; choosing a section closes it.
											setSideOpen(false)
										}}
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
				className={`workspace ${detailsOpen ? 'jobs-open' : ''}`}
				data-panel-resizing={panelResizing || undefined}
				data-panel-expanded={(detailsOpen && panelExpanded) || undefined}
				style={
					panelWidth !== undefined || panelView === 'file' || panelView === 'browse'
						? ({
								'--panel-width': `clamp(${MIN_PANEL_WIDTH}px, ${panelWidth ?? 600}px, 70%)`,
							} as CSSProperties)
						: undefined
				}
				data-pal-workspace={palWorkspace}
				data-computer-chat={computerPage ? chatMotion.renderedLayout : undefined}
				data-chat-minimized={computerPage && floatingChatMinimized}
				data-page={
					railSection === 'plugins' || railSection === 'settings'
						? railSection
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
					{normalTabs.length > 0 || stripTerminals.length > 0 ? (
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
					{!palConversation && sessionId && conversation && !activeTerminal && (
						<div className="conversation-header-actions">
							<ConversationActionsMenu
								input={conversationActionInput(conversation)}
								mac={macPlatform}
								busy={loading || harnessBusy || frozen}
								label="Conversation actions"
								trigger={
									<Button
										type="button"
										variant="ghost-muted"
										size="icon-sm"
										className="conversation-header-button"
										aria-label="Conversation actions"
										title="Conversation actions"
									>
										<MoreHorizontalIcon className="size-4" aria-hidden="true" />
									</Button>
								}
								onAction={(id, trigger) => runConversationAction(id, conversation, trigger)}
							/>
							<ConversationDetailsPopover
								open={detailsPopoverOpen}
								onOpenChange={setDetailsPopoverOpen}
								triggerRef={detailsTrigger}
								project={project && !project.isChat ? project : undefined}
								totals={totals}
								git={git && git.projectId === gitProjectId ? git.value : null}
								work={detailsWork}
								sources={sources}
								attachReason={
									externalHarness
										? 'This engine does not take attachments.'
										: loading || restoringTabs || frozen
											? 'Wait for the conversation to finish loading.'
											: undefined
								}
								onOpenChanges={() => {
									setDetailsPopoverOpen(false)
									setChangesFilter(undefined)
									showPanelTab('changes')
									setJobsOpen(true)
								}}
								onOpenWork={() => {
									setDetailsPopoverOpen(false)
									showPanelTab('activity')
									setJobsOpen(true)
								}}
								onOpenArchived={
									project && !project.isChat && api.archivedConversations
										? () => setArchivedOpen(true)
										: undefined
								}
								onAttach={() => {
									setDetailsPopoverOpen(false)
									void act(attached.pick)
								}}
							/>
						</div>
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
							notice: presentComputerNotice(liveStream?.error) ?? palContextProps.computer.notice,
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
				{railSection === 'settings' && (
					<SettingsPage
						section={settingsSection}
						onSection={(section, focusId) => {
							setSettingsSection(section)
							setSettingsFocus(focusId)
						}}
						focusId={settingsFocus}
						engineTarget={{
							groupId: group.id,
							...(projectId ? { projectId } : {}),
							onShowOutput: (tabId) => {
								setRailSection(null)
								void onAction({ kind: 'activate', groupId: group.id, tabId }).catch((failure) =>
									setError(errorText(failure)),
								)
							},
						}}
						settings={desktopSettings}
						appearance={appearance}
						onAppearanceChange={setAppearance}
						projects={projects.filter((item) => !item.palId && !item.isChat)}
						onRemoveProject={api.removeProject ? requestProjectRemoval : undefined}
						update={
							update
								? {
										...update,
										info: updateInfo,
										onDownload: api.downloadUpdate
											? () =>
													void api
														.downloadUpdate?.()
														.catch((failure) => setError(errorText(failure)))
											: undefined,
									}
								: undefined
						}
						speech={speech}
						info={desktopInfo.info}
						infoError={desktopInfo.error}
						onOpenFolder={
							api.openDataFolder
								? (kind: DataFolderKind) =>
										void api.openDataFolder?.(kind).catch((failure) => setError(errorText(failure)))
								: undefined
						}
						now={Date.now()}
					/>
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
						opening={palOpening}
						onRetryOpening={() => {
							const target = pals.find((item) => item.id === palOpening?.palId)
							if (target) void act(() => beginOpeningPal(target))
						}}
						onCancelOpening={cancelOpeningPal}
						loadProviders={api.palProviders}
						loadModels={api.palModels}
					/>
				)}

				{/* A trust dialog for the folder is the explanation; the banner behind it would repeat it. */}
				{!folderAccess &&
					!project?.missing &&
					(error || (project?.error && !openErrorStage) || savedSettings.error) && (
						<div className="connection-error">
							<ChatErrorBanner
								message={
									project?.lost
										? lostConnectionText(project)
										: (externalHarness &&
												describeEngineFailure(
													savedSettings.error || error || project?.error || '',
													engineLabel(harnessView, permissionEngine),
												)) ||
											savedSettings.error ||
											error ||
											project?.error ||
											''
								}
								signIn={signInHelpFor(savedSettings.error || error || project?.error || '')}
								onOpenTerminal={
									terminalReady ? () => void act(() => openShellTerminal()) : undefined
								}
								onRetry={
									project?.lost && project.reconnecting
										? undefined
										: restoringTabs
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
														void act(async () =>
															updateProject(await api.reconnectProject(project.id)),
														)
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
				{activeTerminal && terminalSessionsHere && !pageOpen && !palsPage ? (
					<TerminalPane
						key={activeTerminal.id}
						tab={activeTerminal}
						session={terminalSessionsHere.get(activeTerminal.id)}
						focused={focused && !frozen}
						onClose={() =>
							void onAction({ kind: 'close', groupId: group.id, tabId: activeTerminal.id }).catch(
								(failure) => setError(errorText(failure)),
							)
						}
						onRestart={
							activeTerminal.kind === 'shell' && terminalReady && window.namzu.openTerminal
								? () =>
										// Not through `act`: closing a tab waits for every pending operation, this one too.
										void (async () => {
											// The same shell starts again in this pane, then the ended tab, which holds
											// nothing but its last screen, goes.
											await openShellTerminal()
											await onAction({ kind: 'close', groupId: group.id, tabId: activeTerminal.id })
										})().catch((failure) => setError(errorText(failure)))
								: undefined
						}
					/>
				) : restoreHold ? (
					<RestoreSkeleton />
				) : !project && !projectsLoaded ? (
					// The list has not been read yet: not knowing is not the same as having none.
					<div className="welcome" aria-busy="true" />
				) : !project ? (
					<Empty className="welcome">
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
						<AddProjectMenu
							disabled={loading}
							onCreate={() => void act(createProject)}
							onOpen={() => void act(openProject)}
							trigger={
								<Button type="button" className="primary" size="default">
									<Icon name="folder" />
									{ADD_PROJECT_LABEL}
								</Button>
							}
						/>
					</Empty>
				) : stage === 'connecting' ? (
					<ProjectConnecting key={project.id} name={project.name} />
				) : stage === 'error' && project.missing ? (
					<ProjectFolderMissing
						name={project.name}
						path={project.path}
						onLocate={
							api.locateProject
								? () => void act(() => locateProject(project))
								: () => void act(openProject)
						}
						onRemove={
							api.removeProject ? (trigger) => requestProjectRemoval(project, trigger) : undefined
						}
						removeDisabled={frozen}
					/>
				) : stage === 'error' ? (
					<ProjectOpenError
						message={project.error || 'Namzu could not connect to this folder.'}
						onRetry={() =>
							void act(async () => {
								// Show connecting at once; the answer replaces it.
								updateProject({ ...project, status: 'connecting', error: undefined })
								try {
									updateProject(await api.reconnectProject(project.id))
								} catch (failure) {
									updateProject(project)
									throw failure
								}
							})
						}
					/>
				) : stage === 'gate' ? (
					<Empty className="welcome">
						<EmptyHeader className="max-w-lg px-8">
							<EmptyTitle>
								<h1>Make this your workspace</h1>
							</EmptyTitle>
							<EmptyDescription className="project-path">{project.path}</EmptyDescription>
							<EmptyDescription>
								Namzu will work with the files in this folder.
								<br />
								{project.settingsChanged?.length
									? 'Its automatic settings changed since you last trusted it.'
									: 'Review the folder before allowing access.'}
							</EmptyDescription>
						</EmptyHeader>
						<Button
							type="button"
							className="primary"
							size="default"
							disabled={project.status !== 'ready'}
							onClick={() => setFolderAccess({ projectId: project.id })}
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
						data-empty={!pal && !historyPending && thread.messages.length === 0}
						data-pal-context={Boolean(palContextProps) && !computerPage && palProfileOpen}
					>
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
							{historyPending && (
								<output className="notice conversation-refresh" aria-live="polite">
									{historyDisplay?.refreshing
										? 'Opening conversation…'
										: 'Conversation could not be loaded.'}
								</output>
							)}
							{historyDisplay?.sessionId === sessionId && historyDisplay.saved && (
								<output className="notice conversation-refresh">
									{historyDisplay.refreshing ? 'Updating conversation…' : 'Saved messages'}
								</output>
							)}
							<div
								className="transcript"
								data-history-state={
									historyPending
										? 'loading'
										: historyDisplay?.sessionId === sessionId && historyDisplay.saved
											? 'saved'
											: 'authoritative'
								}
								role={pal ? 'region' : undefined}
								aria-label={pal ? `${pal.name} conversation` : undefined}
								tabIndex={pal ? 0 : undefined}
								ref={transcriptScroll.ref}
							>
								<div className="conversation-body" aria-busy={historyPending}>
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
											received={palOperatorMessages}
											renderMessageAction={(message, key) => (
												<MessageActions text={message.text}>
													<LocalSpeechReadAloud
														speech={speech}
														messageId={key}
														text={message.text}
													/>
												</MessageActions>
											)}
										/>
									) : (
										<ProviderNameContext.Provider
											value={providerName(choice.provider, failedProviderLabel)}
										>
											<ProjectFilesContext.Provider value={projectFiles}>
												<PalStartContext.Provider value={palStartControls}>
													<Transcript
														key={sessionId || 'blank'}
														thread={thread}
														animate={!historyPending && !restoringTabs}
														workDisclosures={
															workDisclosureView.sessionId === sessionId
																? workDisclosureView.choices
																: undefined
														}
														onWorkDisclosureChange={(key, open) =>
															onWorkDisclosureChange(sessionId, key, open)
														}
														onOpenTurnChanges={(receiptIds, path) => {
															setChangesFilter(receiptIds, path)
															showPanelTab('changes')
															setJobsOpen(true)
														}}
														onOpenChangedFile={projectFiles ? openChangedFile : undefined}
														onOpenPalInbox={openPalInbox}
														onOpenTasks={() => {
															showPanelTab('activity')
															setJobsOpen(true)
														}}
														onUndoTurn={
															api.undoPreview && api.undoTurn
																? (turnId) => setUndoingTurn({ sessionId, turnId })
																: undefined
														}
														undoKept={undoKept}
														projectRoot={project?.path}
														closedWhileRunning={conversation?.closedWhileRunning === true}
														renderMessageAction={(message, key) => (
															<MessageActions
																text={message.text}
																onRetry={
																	retryable && retryable.reply === message
																		? () => void act(() => retryReply(retryable.prompt))
																		: undefined
																}
															>
																<LocalSpeechReadAloud
																	speech={speech}
																	messageId={key}
																	text={message.text}
																/>
															</MessageActions>
														)}
													/>
												</PalStartContext.Provider>
											</ProjectFilesContext.Provider>
										</ProviderNameContext.Provider>
									)}
									<TurnRecovery
										retry={thread.retry}
										failures={replyFailures}
										onAction={(action) => {
											if (action === 'settings') openSettings('models', 'models')
											else if (action === 'continue') void act(continueWithoutReply)
											else if (action === 'copy-to-new') void act(copyMessageToNewConversation)
											else void act(newConversation)
										}}
										disabled={
											thread.running ||
											loading ||
											restoringTabs ||
											frozen ||
											project.status !== 'ready'
										}
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
							{transcriptScroll.showLatest && !historyPending && (
								<Button
									className="transcript-latest"
									variant="glass"
									size="icon"
									aria-label="Jump to latest messages"
									title="Jump to latest messages"
									onClick={transcriptScroll.jumpToLatest}
								>
									<ArrowDown aria-hidden="true" />
								</Button>
							)}
							<Composer
								variant={pal ? 'pal' : 'default'}
								surface={surfaceControl}
								pluginsSupported={!pal}
								toolsAvailable={palCanWork}
								blockedNotice={
									pal?.paused ? `${pal.name} is paused. Resume ${pal.name} to chat.` : undefined
								}
								draftDisabled={
									loading ||
									restoringTabs ||
									frozen ||
									Boolean(group.activeTabId && group.activeTabId !== sessionId)
								}
								inputRef={input}
								permissions={thread.permissions}
								palNames={palNames}
								onApproval={async (permission, response) => {
									// The card stays usable when the answer did not get through.
									let delivered = false
									await act(async () => {
										await api.respondPermission(permission.sessionId, permission.id, response)
										delivered = true
									})
									return delivered
								}}
								projectName={project.name}
								starters={homeStarters(project)}
								emptyHeading={projectHomeHeading(project)}
								projectId={project.id}
								sessionId={sessionId || undefined}
								projectPath={project.path}
								harnessView={harnessView}
								permissionEngine={permissionEngine}
								harnessBusy={harnessBusy || loading || restoringTabs || frozen}
								onHarnessChange={(engine) => void act(() => selectHarness(engine))}
								onRecheckEngines={() => act(retryConversationSetup)}
								attachmentsSupported={!externalHarness}
								reviewModes={permissionEngine === 'claude-code' ? ['prompt', 'plan'] : undefined}
								permissionScope={draftOwner}
								onLeaveProject={() => void act(leaveProject)}
								projects={projects.filter((item) => !item.palId)}
								onSelectProject={(item) => selectProject(item.id)}
								onOpenProject={() => void act(openProject)}
								onCreateProject={() => void act(createProject)}
								empty={!pal && !historyPending && thread.messages.length === 0}
								draft={draft}
								onDraftChange={(value) => changeDraft(draftOwner, value)}
								providers={activeProviders}
								modelSelectionReady={
									project.status === 'ready' &&
									providerReady &&
									attached.loaded &&
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
									attached.loaded &&
									project.trusted &&
									!savedSettings.loading &&
									!harnessBusy &&
									!loading &&
									!restoringTabs
								}
								providersLoading={!providerReady}
								onOpenModelSettings={() => openSettings('models', 'models')}
								catalogueReady={
									project.status === 'ready' && providerReady && project.trusted && !harnessBusy
								}
								startingEngine={harnessBusy ? startingEngine : undefined}
								startFailed={Boolean(error)}
								modelPending={
									project.status === 'ready' &&
									project.trusted &&
									(!providerReady ||
										!attached.loaded ||
										savedSettings.loading ||
										harnessBusy ||
										loading ||
										restoringTabs)
								}
								choice={choice}
								choiceUnchosen={choiceUnchosen}
								onChoiceChange={(value) => {
									void act(() =>
										savedSettings.save(draftOwner, {
											choice: value,
											// The saved effort stays while the new model offers it; the effect below
											// clears it once that model's levels are known and it does not.
											options: settings,
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
								liveInputSupported={thread.liveInputSupported && !palConversation}
								liveInputs={thread.liveInputs}
								sending={sending[draftOwner] ?? false}
								queued={thread.queued}
								queuedItems={thread.queuedItems}
								queueParked={queueParked(thread)}
								editingQueued={queueEditing[sessionId] ?? false}
								onSend={() => void act(send)}
								onQueue={() => void act(() => send('queue'))}
								onStop={() => void act(() => api.cancel(sessionId))}
								onEditQueued={(itemId) => void act(() => editQueued(itemId))}
								onRemoveQueued={(itemId) => void act(() => api.removeQueued(sessionId, itemId))}
							/>
							{speech.error && (
								<p className="inline-error" role="alert">
									{speech.error}
								</p>
							)}
						</div>
					</div>
				)}
				{!palConversation && (
					<aside
						ref={panelAside}
						className="jobs-panel"
						data-open={jobsOpen}
						inert={!jobsOpen}
						aria-hidden={!jobsOpen}
						aria-label={
							panelView === 'activity'
								? 'Activity'
								: panelView === 'changes'
									? 'Changes'
									: panelView === 'empty'
										? 'Side panel'
										: 'Project files'
						}
					>
						<PanelResizeHandle
							now={panelPx || panelWidth || MIN_PANEL_WIDTH}
							min={MIN_PANEL_WIDTH}
							max={() => (paneRoot.current?.getBoundingClientRect().width ?? 0) * 0.7}
							width={() => panelAside.current?.getBoundingClientRect().width ?? MIN_PANEL_WIDTH}
							onDragging={setPanelResizing}
							onResize={(width) =>
								setPanelWidth(
									clampPanelWidth(width, paneRoot.current?.getBoundingClientRect().width ?? 0),
								)
							}
							onCommit={(width) =>
								writePanelWidth(
									localStorage,
									group.id,
									clampPanelWidth(width, paneRoot.current?.getBoundingClientRect().width ?? 0),
								)
							}
						/>
						<div className="section-heading panel-heading">
							<PanelTabStrip
								panelId="side-panel-body"
								tabs={listedTabs}
								active={shownPanelTab}
								browsing={panelView === 'browse'}
								canBrowse={filesEnabled}
								running={detailsWork.state === 'known' ? detailsWork.running : 0}
								attention={needsAttention}
								expanded={panelExpanded}
								onActivate={(tab) => {
									if (tab.kind === 'changes') setChangesFilter(undefined)
									updatePanelTabs((state) => activatePanelTab(state, tab))
								}}
								onClose={(tab) => updatePanelTabs((state) => closePanelTab(state, tab))}
								onOpenTab={(tab) => {
									if (tab.kind === 'changes') setChangesFilter(undefined)
									showPanelTab(tab.kind === 'changes' ? 'changes' : 'activity')
								}}
								onBrowse={() => updatePanelTabs(browsePanelTabs)}
								onToggleExpanded={() => setPanelExpanded((value) => !value)}
								onHide={closeDetails}
							/>
						</div>
						{/* The body is a tab panel; contents keeps the aside's own layout. */}
						<div
							id="side-panel-body"
							role="tabpanel"
							aria-label={
								panelView === 'activity'
									? 'Activity'
									: panelView === 'changes'
										? 'Changes'
										: panelView === 'empty'
											? 'Side panel'
											: 'Project files'
							}
							style={{ display: 'contents' }}
						>
							{(panelView === 'file' || panelView === 'browse') && project ? (
								<FilePanelBody
									api={api}
									projectId={project.id}
									projectName={project.name}
									activePath={activePath}
									line={panelTabs.line}
									editors={editors}
									dark={
										appearance === 'dark' ||
										(appearance === 'system' &&
											window.matchMedia('(prefers-color-scheme: dark)').matches)
									}
									wide={panelPx >= 560}
									browsing={panelView === 'browse'}
									onOpenPath={openProjectFile}
									onNotice={announce}
									refreshToken={filesRefresh}
								/>
							) : panelView === 'empty' ? (
								<div className="panel-empty">
									<p>Nothing is open in this panel.</p>
									<div className="panel-empty-actions">
										<Button
											type="button"
											size="xs"
											variant="ghost-muted"
											onClick={() => {
												setChangesFilter(undefined)
												showPanelTab('changes')
											}}
										>
											Changes
										</Button>
										<Button
											type="button"
											size="xs"
											variant="ghost-muted"
											onClick={() => showPanelTab('activity')}
										>
											Activity
										</Button>
										{filesEnabled && (
											<Button
												type="button"
												size="xs"
												variant="ghost-muted"
												onClick={() => updatePanelTabs(browsePanelTabs)}
											>
												Open a file
											</Button>
										)}
									</div>
								</div>
							) : panelView === 'changes' ? (
								<ChangesPanel
									tools={thread.tools}
									timeline={thread.timeline}
									receiptIds={changesFilter}
									focus={changesFocus}
									onShowAll={() => setChangesFilter(undefined)}
									source={workingTree}
									refreshToken={filesRefresh}
									onOpenFile={projectFiles ? openChangedFile : undefined}
									onOpenInEditor={
										projectFiles && api.openProjectPath ? openChangedFileInEditor : undefined
									}
									onOpenWorkingFile={projectFiles ? openWorkingTreeFile : undefined}
									onOpenWorkingInEditor={
										projectFiles && api.openProjectPath ? openWorkingTreeFileInEditor : undefined
									}
									onCopy={(text, done) =>
										void copyToClipboard(text, done).catch(() =>
											notify('Copy is unavailable.', { tone: 'error' }),
										)
									}
									dark={
										appearance === 'dark' ||
										(appearance === 'system' &&
											window.matchMedia('(prefers-color-scheme: dark)').matches)
									}
								/>
							) : (
								<div className="panel-scroll">
									<ConversationTasks thread={thread} />
									<section className="background-processes" aria-label="Background processes">
										<div className="background-processes-heading">
											<h3>Background processes</h3>
											{!jobsError && !jobsLoading && jobsSessionId === sessionId && (
												<kbd
													aria-label={`${visibleJobs.filter((job) => job.status === 'running').length} running`}
												>
													{visibleJobs.filter((job) => job.status === 'running').length}
												</kbd>
											)}
										</div>
										{jobsError ? (
											<p role="alert" className="jobs-error">
												{jobsError}
											</p>
										) : jobsLoading || jobsSessionId !== sessionId ? (
											<p className="quiet">Loading background work…</p>
										) : visibleJobs.length === 0 ? (
											<p className="quiet">No background processes in this conversation.</p>
										) : (
											[...visibleJobs]
												.sort(
													(a, b) => Number(b.status === 'running') - Number(a.status === 'running'),
												)
												.map((job) => {
													const owner = sessionId
													const generation = navigation.current
													const refresh = refreshJobs.current
													return (
														<JobRow
															key={`${owner}:${generation}:${job.id}:${job.startedAt}`}
															job={job}
															disabled={frozen}
															onRead={() =>
																runJobAction(owner, generation, () => api.readJob(owner, job.id))
															}
															onStop={() =>
																runJobAction(owner, generation, async () => {
																	await api.stopJob(owner, job.id)
																	await refresh?.()
																})
															}
														/>
													)
												})
										)}
									</section>
								</div>
							)}
						</div>
					</aside>
				)}
			</main>
		</PaneToasts>
	)
}
