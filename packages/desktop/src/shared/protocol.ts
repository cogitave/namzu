import type {
	AcpSessionUpdate,
	AcpTask,
	PalAppearance,
	PalComputerControlState,
	PalComputerInput,
	ReasoningEffort,
	ReviewMode,
} from '@namzu/sdk'
import type { BackgroundWorkStatus, BackgroundWorkStatusEvent } from './background-work-protocol.js'
import type {
	EngineUpdateAnnouncement,
	EngineUpdateNotice,
	EngineUpdateRequest,
	EngineUpdateResult,
	EngineUpdatesState,
} from './engine-update-protocol.js'
import type {
	PalCommunicationView,
	PalInboxView,
	PalPermissionChange,
	PalSubscriptionCreate,
	PalSubscriptionDisable,
} from './pal-communication-protocol.js'
import type {
	DataFolderKind,
	DesktopInfo,
	DesktopSettings,
	SettingsChangeResult,
	SettingsSection,
} from './settings-protocol.js'
import type { TerminalTabView } from './terminal-tabs.js'
import type {
	TerminalAttachOptions,
	TerminalAttachView,
	TerminalAvailability,
	TerminalEvent,
	TerminalOpenRequest,
	TerminalOpenResult,
	TerminalShellChoice,
} from './terminal-view.js'
import type {
	UpdateInfo,
	UpdateInstallResult,
	UpdateState,
	UpdateUiBusy,
} from './update-protocol.js'
export type { PalComputerInput } from '@namzu/sdk'
import type {
	WorkspaceDropPosition,
	WorkspaceLayoutSnapshot,
	WorkspaceNode,
	WorkspaceWindowBounds,
} from './workspace-layout.js'

export interface WorkspaceView {
	windowId: string
	/** Includes uncommitted transfer preparation changes as well as layout revisions. */
	sequence: number
	/** Stable controller identity for the ordinary empty conversation before its first session. */
	homeGroupId: string
	layout: WorkspaceLayoutSnapshot
	/** Render-only destination. The source retains its writer lease until ready is acknowledged. */
	pendingTransfer?: {
		id: string
		tabId: string
		sourceWindowId: string
		destinationWindowId: string
		sourcePrepared: boolean
		previewRoot: WorkspaceNode
	}
	outgoingTransfer?: {
		id: string
		tabId: string
		destinationWindowId: string
		prepared: boolean
	}
	closingWindow?: { id: string; tabIds: string[] }
}
export type WorkspaceAction =
	| { kind: 'open'; tabId: string; groupId?: string }
	| { kind: 'cancel-transfer'; transferId: string }
	| { kind: 'cancel-close'; closeId: string }
	| { kind: 'focus'; groupId: string }
	| { kind: 'close' | 'activate'; groupId: string; tabId: string }
	| {
			kind: 'move'
			tabId: string
			sourceGroupId: string
			sourceWindowId?: string
			targetWindowId: string
			targetGroupId: string
			position: WorkspaceDropPosition
			index?: number
			size?: { width: number; height: number }
	  }
	| { kind: 'resize'; splitId: string; ratio: number }
	| {
			kind: 'detach'
			tabId: string
			sourceGroupId: string
			bounds?: WorkspaceWindowBounds
	  }

export interface AttachmentView {
	id: string
	name: string
	kind: 'image' | 'text'
	size: number
	mediaType: string
	preview?: string
}
export interface AttachmentInput {
	name: string
	bytes: Uint8Array
}
export interface DesktopSendOptions {
	attachmentIds?: string[]
	effort?: ReasoningEffort
	permissionMode?: ReviewMode
}
export interface DraftSettings {
	/** `preset: 'default'` follows the engine's own default model as its catalogue changes. */
	choice?: {
		provider: string
		model: string
		label?: string
		preset?: 'default'
		/** The picker settled on this model by itself; it is saved but not remembered as a pick. */
		auto?: true
	}
	options?: Omit<DesktopSendOptions, 'attachmentIds'>
}
export interface ComposerModelSettings {
	effortLevels?: readonly ReasoningEffort[]
	effortDefault?: ReasoningEffort
	notice?: string
}
export interface PluginInventoryView {
	/** Catalogue entries are distinct from installation locations. Absent means unavailable. */
	publicPlugins?: readonly {
		name: string
		version: string
		description: string
	}[]
	publicNotice?: string
	plugins: readonly {
		name: string
		version: string
		description: string
		scope: 'project' | 'user'
		status: string
		startupEnabled?: boolean
		startupError?: string
	}[]
	live: boolean
	canChange: boolean
	notice?: string
}

/** What happened to a removed project's entry in Namzu's trust list. */
export type ProjectUntrust =
	| { state: 'removed' | 'not-connected' | 'unsupported' }
	/** An ancestor folder is trusted, so this one still is until that entry goes. */
	| { state: 'still-trusted'; by: string }

export interface ProjectRemovalResult {
	projectId: string
	/** Conversations whose tabs were closed with the project. */
	sessionIds: string[]
	trust: ProjectUntrust
	/**
	 * Main's one-time proof, valid for a few minutes in this window, that the person just
	 * removed this folder: `restoreProject` takes it to add the folder back.
	 */
	readdToken?: string
}

/** Why a folder needs an explicit in-app confirmation before it is trusted. */
export type BroadFolderKind = 'drive' | 'home' | 'system'

export interface ProjectView {
	id: string
	path: string
	name: string
	trusted: boolean
	status: 'connecting' | 'ready' | 'error'
	error?: string
	palId?: string
	/** App-created ordinary chat context, not a user project or Pal workspace. */
	isChat?: boolean
	/**
	 * The folder is gone (moved, renamed or deleted). The project stays listed, without a
	 * connection, so the person can point Namzu at the new place (`locateProject`) or remove it.
	 */
	missing?: true
	/**
	 * Present only on the answer to a pick or a trust request for a broad folder: it was
	 * not trusted, and `token` is the one-time proof to send back to `trustProject`.
	 */
	broadFolder?: { kind: BroadFolderKind; token: string }
	/**
	 * Present on the answer to a pick or a trust request when the folder holds settings that
	 * run code on their own: it was not trusted, `found` names what main saw, and `token` is
	 * the one-time proof to send back (`trustFolder` for a pending pick, else `trustProject`).
	 */
	riskySettings?: {
		found: string[]
		/** The commands, servers or names behind some of `found`, for the dialog's Details. */
		details?: { label: string; lines: string[] }[]
		token: string
	}
	/**
	 * The folder was trusted but its automatic settings changed since (hooks, servers, plugins,
	 * commands…). It is treated as untrusted until the person confirms; `trust` clears this.
	 */
	settingsChanged?: string[]
	/**
	 * The connection to Namzu dropped while the project was open. The conversation stays on
	 * screen; `reconnecting` is true while Namzu is already trying again on its own.
	 */
	lost?: true
	reconnecting?: true
	/**
	 * A picked folder that is not in the app yet: only `trustFolder` adds it. It carries either
	 * `broadFolder` or `riskySettings`, whose token is what `trustFolder` takes.
	 */
	pending?: true
}
export interface ConversationView {
	id: string
	projectId: string
	title: string
	updatedAt: string
	palId?: string
	harness?: 'namzu' | 'codex-cli' | 'claude-code'
	/** Host-authored prelude from the durable claim's original profile revision. */
	palGreeting?: { id: string; text: string }
	/** Desktop-local: pinned conversations lead their lists. */
	pinned?: true
	/** Desktop-local: the window was closed while a reply was running, so that reply never finished. */
	closedWhileRunning?: true
}
/** Repository facts for a trusted project; `branch` is null on a detached head. */
export interface ProjectGitView {
	branch: string | null
	subject: string | null
}
export interface HarnessView {
	selected: 'namzu' | 'codex-cli' | 'claude-code'
	locked: boolean
	engines: {
		id: HarnessView['selected']
		label: string
		available: boolean
		notice?: string
	}[]
	/** What engine starts cost since the last report; the main process records it, the UI ignores it. */
	timings?: EngineTimingReport[]
}
/** What starting an external engine cost, in milliseconds. A step that did not run is absent. */
export interface EngineTimingReport {
	engine: 'codex-cli' | 'claude-code'
	operation: 'open' | 'models'
	timings: {
		spawnMs?: number
		initializeMs?: number
		modelListMs?: number
		totalMs: number
		reused?: boolean
	}
}
export interface ChatMessage {
	/** First host observation or durable journal time; absent when timing is unknown. */
	time?: { at: number; source: 'host' | 'journal' }
	role: 'user' | 'assistant'
	text: string
	messageId?: string
	textPartId?: string
	phase?: 'commentary' | 'final_answer'
	status?: 'pending' | 'completed'
	stopReason?: import('@namzu/sdk').MessageStopReason
	attachments?: AttachmentView[]
}
export interface ProviderView {
	available: {
		id: string
		label: string
		defaultModel: string
		/** An external engine's installed build; a stored model list is keyed by it. */
		identity?: string
		/** Free models with no key: listed, but not a connection a person set up. */
		anonymous?: true
	}[]
	selected: { id: string; model?: string } | null
}
/** One provider in Settings ▸ Models. Never carries a key. */
export interface ProviderConnectionView {
	id: string
	label: string
	/** `free` is the keyless free tier: offered, not a connection. */
	state: 'connected' | 'free' | 'not-connected'
	how?:
		| 'environment'
		| 'saved-key'
		| 'claude-sign-in'
		| 'codex-sign-in'
		| 'gemini-sign-in'
		| 'namzu-sign-in'
		| 'opencode-key'
		| 'local'
		| 'free'
	/** The environment variable's name that supplied the key; never its value. */
	envName?: string
	canSaveKey: boolean
	/** A pasted key Namzu holds, which Remove deletes. */
	hasSavedKey: boolean
	help?: string
}
export type ProviderTestResult = 'ok' | 'rejected' | 'unchecked' | 'missing'

export interface ModelCatalogueView {
	/** `default` marks this engine's own recommended default model. */
	models: {
		id: string
		label: string
		note?: string
		default?: true
		/** The source itself calls this model current (an engine's own alias or default), not an older release. */
		current?: true
		/** Zen only: `free` is a stated 0/0 price, `key` a stated non-zero one; absent when no price is published. */
		group?: 'free' | 'key'
		/** ISO time main first saw this id in a list it had already stored; absent when unknown. */
		firstSeen?: string
	}[]
	notice: string | null
	/** Epoch milliseconds of the read behind a stored list; absent on a live read. */
	fetchedAt?: number
	/** What the engine start behind a live read cost; the main process records it. */
	timings?: EngineTimingReport[]
}
/** What the File menu's tab entries ask a window to do. */
export type TabCommand = 'close' | 'next' | 'previous'
export interface PalView {
	id: string
	name: string
	purpose: string
	revision: number
	workspace: string
	model: { provider: string; model: string } | null
	appearance?: PalAppearance
	paused: boolean
	createdAt: string
	updatedAt: string
}
export interface PalInput {
	name: string
	purpose?: string
	model?: PalView['model']
	appearance?: PalAppearance
}
/**
 * A create carries the id of the attempt. The same id sent twice (a double click, a retry) makes
 * one Pal and returns it both times.
 */
export interface PalCreateInput extends PalInput {
	requestId?: string
}
export interface PalChanges extends PalInput {
	paused?: boolean
}
/**
 * What waits in a Pal's inbox for the person's go. `waiting` offers "Start"; `reading` means a run
 * is reading the messages now; `failed` carries plain words and offers Retry.
 */
export interface PalInboxStartView {
	v: 1
	palId: string
	waiting: number
	state: 'empty' | 'waiting' | 'reading' | 'failed'
	message?: string
}
export interface HumanComputerView {
	name: string
	platform: 'win32' | 'darwin' | 'linux' | 'other'
}
export interface PalComputerView {
	control?: PalComputerControlState
	status: 'stopped' | 'ready' | 'unavailable'
	requiresStop?: boolean
	notice?: string
	environmentId?: string
	generation?: string
}
export interface PalScreenView {
	source: string
	width: number
	height: number
}
/** A native, read-only viewer ticket. The guest allocation credential stays in main. */
export interface PalComputerStreamView {
	id: string
	url: string
	width: number
	height: number
	generation: string
}
export interface JobView {
	id: string
	command: string
	status: string
	startedAt: number
	exitCode?: number
	/** Termination is unconfirmed; the job remains owned and running. */
	recoveryRequired?: boolean
	/** Safe registry diagnostic; never the process provider's raw error. */
	stopError?: string
}
export interface QueuedMessageView {
	id: string
	prompt: string
	attachments?: AttachmentView[]
	effort?: ReasoningEffort
	permissionMode?: DesktopSendOptions['permissionMode']
}
/** The file change a pending edit or write would make, worked out by the CLI. `before: null` is a new file. */
export interface PermissionPreview {
	path: string
	before: string | null
	after: string
	truncated?: boolean
}
export interface PermissionView {
	id: string
	sessionId: string
	projectId: string
	calls: {
		id: string
		name: string
		input: unknown
		isDestructive: boolean
		/** Absent for other tools and for engines that send none. */
		preview?: PermissionPreview
	}[]
}
/** Reject carries the person's note to the model (`feedback`) and, apart from any wrapper, as they wrote it (`note`) for the record; approve carries nothing. */
export type PermissionResponse =
	| { outcome: 'approve'; feedback?: undefined }
	| { outcome: 'reject'; feedback?: string; note?: string }
export type WindowMenu = 'edit' | 'view' | 'window'
export type WindowAppearance = 'light' | 'dark'
export interface WindowChrome {
	platform: 'darwin' | 'win32' | 'linux' | 'other'
	height: 32
}
export interface WindowMenuAnchor {
	x: number
	y: number
}
export interface DesktopTurnRetry {
	turnId: string
	checkpointId: string
}
export interface DesktopRetryStatus {
	retry?: DesktopTurnRetry
	notice?: string
}
/** What undoing a reply stands at; read from the CLI's file history, never kept by the UI. */
export type DesktopUndoState = 'applied' | 'undone' | 'partially_undone' | 'none' | 'expired'
export type DesktopUndoSkipReason = 'too-large' | 'outside-cwd' | 'sandbox' | 'snapshot-failed'
export interface DesktopUndoSkipped {
	path: string
	reason: DesktopUndoSkipReason
}
export interface DesktopTurnUndo {
	turnId: string
	status: DesktopUndoState
	files: number
	added: number
	removed: number
	/** A shell command ran in the reply; undo cannot reverse what it changed. */
	uncoveredShell: boolean
	skipped: DesktopUndoSkipped[]
	/** Host clock of an undo this window observed; absent after a cold reopen. */
	undoneAt?: number
}
export type DesktopUndoAction = 'restore' | 'delete' | 'noop' | 'conflict'
export type DesktopUndoConflictReason =
	| 'drifted'
	| 'later-reply'
	| 'unavailable'
	| 'symlink'
	| 'outside-cwd'
export interface DesktopUndoFile {
	turnId: string
	path: string
	rel: string
	action: DesktopUndoAction
	reason?: DesktopUndoConflictReason
	blockedBy?: string[]
}
export interface DesktopUndoPreview {
	turnId: string
	status: 'applied' | 'undone' | 'partially_undone'
	/** Names the plan the operator saw; an undo of any other plan is refused and re-planned. */
	planToken: string
	files: DesktopUndoFile[]
	skipped: DesktopUndoSkipped[]
	uncoveredShell: boolean
	laterTurnsOnSameFiles: string[]
}
export type DesktopUndoFileResult = 'restored' | 'removed' | 'skipped' | 'failed' | 'noop'
export interface DesktopUndoOptions {
	/** Per path: skip (the default) or keep a copy of the file as it is now, then restore. */
	resolutions?: Record<string, 'skip' | 'keep_copy'>
	alsoUndoLater?: boolean
}
export interface DesktopUndoResult {
	turnId: string
	/** `plan-changed` means nothing was written and `replan` is what to show instead. */
	status: 'applied' | 'undone' | 'partially_undone' | 'plan-changed'
	files: Record<string, DesktopUndoFileResult>
	later?: Record<string, Record<string, DesktopUndoFileResult>>
	copies?: { path: string; sha256: string }[]
	replan?: DesktopUndoPreview
}
export type DesktopEvent = (
	| BackgroundWorkStatusEvent
	| {
			kind: 'prompt'
			sessionId: string
			prompt: string
			attachments?: AttachmentView[]
	  }
	| {
			kind: 'update'
			projectId: string
			sessionId: string
			update: AcpSessionUpdate
	  }
	| { kind: 'permission'; request: PermissionView }
	| { kind: 'task'; sessionId: string; task: AcpTask; deleted?: true }
	| { kind: 'tasks'; sessionId: string; tasks?: AcpTask[]; notice?: string }
	| { kind: 'permission-cleared'; sessionId: string; requestId?: string }
	/** Display-only retirement; admitted, queued and retry file bytes are unchanged. */
	| {
			kind: 'attachment-previews-evicted'
			sessionId: string
			attachmentIds: string[]
	  }
	| ({ kind: 'retry-status'; sessionId: string } & DesktopRetryStatus)
	| { kind: 'retry'; sessionId: string; turnId: string }
	| { kind: 'undo-status'; sessionId: string; turns: DesktopTurnUndo[] }
	| {
			kind: 'state'
			sessionId: string
			running: boolean
			liveInputSupported?: boolean
			queued: string[]
			queuedItems?: QueuedMessageView[]
			error?: string
			/** The connection came back: drop the error that said it was lost. */
			clearError?: true
			/** Actual first-prompt preflight recovery; never overwrites a newer authored edit. */
			restoredDraft?: string
	  }
	| {
			kind: 'live-input'
			sessionId: string
			inputId: string
			prompt: string
			status: 'pending' | 'delivered' | 'unknown' | 'queued'
	  }
	| { kind: 'connection'; project: ProjectView }
	| { kind: 'workspace'; view: WorkspaceView }
	/** The terminal tabs changed (one added, ended, renamed, closed or its badge moved). */
	| { kind: 'terminals'; terminals: TerminalTabView[] }
	/** The saved preferences changed; every window follows. */
	| { kind: 'settings'; settings: DesktopSettings }
	/** The native menu or a shortcut asked for Settings; only the focused window gets it. */
	| { kind: 'open-settings'; section?: SettingsSection }
	/** A File menu tab entry (Close tab, Next tab, Previous tab); only the focused window gets it. */
	| { kind: 'tab-command'; command: TabCommand }
	| { kind: 'project-removed'; projectId: string; sessionIds: string[] }
	/** A stored model list was refreshed and its rows differ; the next read returns the new rows. */
	| { kind: 'model-catalogue-updated'; engine: string; provider: string }
	/** A key was saved or removed: every window re-reads which providers can answer. */
	| { kind: 'providers-changed' }
	| {
			kind: 'pal-deleted'
			palId: string
			projectIds: string[]
			sessionIds: string[]
	  }
	| { kind: 'conversation-updated'; sessionId: string; view: ConversationView }
	| {
			kind: 'conversation-removed'
			sessionId: string
			projectId: string
			archived: boolean
	  }
) & { readonly revision?: number; readonly at?: number }
/** One changed file of a project working tree. */
export interface ProjectChangeFile {
	path: string
	status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'binary'
	added: number
	removed: number
	/** Previous path when `status` is 'renamed'. */
	oldPath?: string
	/** Set on a renamed file whose content is not text. */
	binary?: true
}

/** The working-tree changes of a project; `truncated` when a cap was hit. */
export interface ProjectChangesView {
	files: ProjectChangeFile[]
	truncated: boolean
}

/** Both sides of one changed file; a null side means the file is absent there. */
export interface ProjectDiffView {
	before: string | null
	after: string | null
	binary: boolean
	truncated: boolean
}

/** One entry of a project directory listing. */
export interface ProjectFileEntry {
	name: string
	/** Project-relative, '/' separated. */
	path: string
	kind: 'file' | 'directory'
}
export interface ProjectFileContent {
	path: string
	size: number
	kind: 'text' | 'image' | 'binary' | 'too-large'
	/** Text up to 2 MiB, strict UTF-8. */
	text?: string
	/** Sniffed raster image up to 4 MiB as a data: URL. */
	image?: string
	/** Markdown only, parsed with yaml in main. */
	frontmatter?: { key: string; value: string }[]
	/** Markdown body without the frontmatter block. */
	markdown?: string
}
export interface ProjectLinkResolution {
	ref: string
	path?: string
	line?: number
}
/**
 * What main knows before the page paints, read once through a synchronous preload call. It is
 * seed data only: every field is replaced by the asynchronous read that follows, and a window
 * that gets no snapshot works exactly as before.
 */
export interface DesktopBoot {
	settings: DesktopSettings
	workspace: WorkspaceView
	/** Saved projects not yet connected read as `connecting`; ids match the ones that connect. */
	projects: ProjectView[]
	/** The saved views of the conversations that are open as tabs in this window. */
	conversations: ConversationView[]
	/** True for a window created by this app start, once; false for one opened later or reloaded. */
	launch: boolean
}

export interface DesktopApi {
	/** The pre-paint snapshot; absent when main did not answer. */
	readonly boot?: DesktopBoot
	/** Open a user-selected HTTP(S) source in the system browser. */
	openExternal?(url: string): Promise<void>
	/** Explicit plain-text copy; bounded to 4 MiB UTF-8 and never truncated. */
	copyText?(text: string): Promise<void>
	/** One directory of a project, ignored paths hidden; `dir` '' is the root. */
	listProjectDirectory?(projectId: string, dir: string): Promise<ProjectFileEntry[]>
	/** Every project path for quick open; `truncated` when a cap was hit. */
	projectFileIndex?(projectId: string): Promise<{ paths: string[]; truncated: boolean }>
	/** A project file as text, image or a size/binary verdict. */
	readProjectFile?(projectId: string, path: string): Promise<ProjectFileContent>
	/** Working-tree changes; null when not a git repository, untrusted or unavailable. */
	projectChanges?(projectId: string): Promise<ProjectChangesView | null>
	/** Before and after text of one changed file. */
	projectDiff?(projectId: string, path: string): Promise<ProjectDiffView>
	/** Which reply references name real project files, and at which line. */
	resolveProjectLinks?(projectId: string, refs: string[]): Promise<ProjectLinkResolution[]>
	/** Open a project path in an editor, the file manager or a terminal. */
	openProjectPath?(
		projectId: string,
		path: string,
		target: 'editor' | 'file-manager' | 'terminal',
		line?: number,
	): Promise<void>
	/** Editors found on this machine. */
	projectEditors?(): Promise<{ id: 'vscode' | 'cursor'; label: string }[]>
	/** Archived conversations of a project. */
	archivedConversations?(projectId: string): Promise<ConversationView[]>
	/** Bring an archived conversation back into the catalogue. */
	restoreConversation?(sessionId: string): Promise<ConversationView>
	/**
	 * The head of a public HTTPS page a reader is looking at. `null` means no
	 * details for this link — refused, not HTML, unreachable or too slow — and
	 * never carries a reason, so no page text or address reaches diagnostics.
	 */
	linkPreview?(url: string): Promise<import('./link-preview-protocol.js').LinkPreviewPage | null>
	/** A sniffed raster image as a `data:` URL, or `null`. */
	linkPreviewImage?(
		url: string,
		kind: import('./link-preview-protocol.js').LinkPreviewImageKind,
	): Promise<string | null>
	localSpeechState?(): Promise<import('./local-speech-protocol.js').LocalSpeechState>
	localSpeechConfigure?(
		settings: Partial<import('./local-speech-protocol.js').LocalSpeechSettings>,
	): Promise<import('./local-speech-protocol.js').LocalSpeechState>
	localSpeechInstall?(): Promise<import('./local-speech-protocol.js').LocalSpeechState>
	/** Delete the downloaded voice engine; the saved speech preferences stay. */
	localSpeechUninstall?(): Promise<import('./local-speech-protocol.js').LocalSpeechState>
	localSpeechSpeak?(
		input: import('./local-speech-protocol.js').LocalSpeechSpeakInput,
	): Promise<{ requestId: string }>
	localSpeechCancel?(requestId: string): Promise<void>
	localSpeechAcknowledge?(requestId: string, sequence: number): Promise<void>
	onLocalSpeechEvent?(
		listener: (event: import('./local-speech-protocol.js').LocalSpeechEvent) => void,
	): () => void
	workspace?(): Promise<WorkspaceView>
	workspaceAction?(action: WorkspaceAction): Promise<WorkspaceView>
	workspaceReady?(transferId: string): Promise<WorkspaceView>
	workspaceCloseReady?(closeId: string): Promise<void>
	/** Native diagnostic paths and storage status; never journal or raw error payloads. */
	diagnostics?(): Promise<DesktopDiagnosticsView>
	setComputerKeyboardCapture?(enabled: boolean): Promise<void>
	/** Saved preferences main acts on; changes arrive as `settings` events. */
	settings?(): Promise<DesktopSettings>
	setSettings?(patch: Partial<DesktopSettings>, token?: string): Promise<SettingsChangeResult>
	desktopInfo?(): Promise<DesktopInfo>
	/** Opens one of the app's own data folders in the file manager. */
	openDataFolder?(kind: DataFolderKind): Promise<void>
	/** Reveal one Pal's workspace folder in the file manager; main resolves the path from the Pal. */
	openPalFolder?(id: string): Promise<void>
	windowChrome(): Promise<WindowChrome>
	setWindowAppearance(appearance: WindowAppearance): Promise<void>
	popupWindowMenu(menu: WindowMenu, anchor: WindowMenuAnchor): Promise<void>
	projects(): Promise<ProjectView[]>
	pals(): Promise<PalView[]>
	palProviders(): Promise<ProviderView>
	/** Settings ▸ Models: every provider Namzu can use and how each is connected. */
	providerConnections?(): Promise<ProviderConnectionView[]>
	/** Saves a pasted key in the CLI's private store. The key is never returned or logged. */
	saveProviderKey?(provider: string, apiKey: string): Promise<ProviderConnectionView[]>
	removeProviderKey?(provider: string): Promise<ProviderConnectionView[]>
	/** A cheap authenticated check; never a model turn. */
	testProvider?(provider: string): Promise<ProviderTestResult>
	palModels(provider: string): Promise<ModelCatalogueView>
	createPal(input: PalCreateInput): Promise<PalView>
	updatePal(id: string, expectedRevision: number, changes: Partial<PalChanges>): Promise<PalView>
	/** Retire the profile after confirmed guest cleanup; workspace files and journals remain. */
	deletePal?(id: string, expectedRevision: number): Promise<{ id: string; deleted: true }>
	palCommunication?(sessionId: string, palId: string): Promise<PalCommunicationView>
	/** The inbox rows alone, read without disturbing an open settings dialog. */
	palInbox?(sessionId: string, palId: string): Promise<PalInboxView[]>
	updatePalPermission?(
		sessionId: string,
		palId: string,
		change: PalPermissionChange,
	): Promise<PalCommunicationView>
	createPalSubscription?(
		sessionId: string,
		palId: string,
		input: PalSubscriptionCreate,
	): Promise<PalCommunicationView>
	disablePalSubscription?(
		sessionId: string,
		palId: string,
		input: PalSubscriptionDisable,
	): Promise<PalCommunicationView>
	openPal(id: string): Promise<{
		pal: PalView
		project: ProjectView
		conversations: ConversationView[]
	}>
	palComputer(id: string): Promise<PalComputerView>
	/** What waits in one Pal's inbox. Optional: an older runtime cannot start a Pal from the app. */
	palInboxStart?(palId: string): Promise<PalInboxStartView>
	/**
	 * The person's click on "Start <Pal>". Main mints the evidence for the click itself; the caller
	 * supplies only the Pal.
	 */
	startPalInbox?(palId: string): Promise<PalInboxStartView>
	startPalComputer(id: string): Promise<PalComputerView>
	stopPalComputer(id: string): Promise<PalComputerView>
	rebootPalComputer?(id: string, generation: string): Promise<PalComputerView>
	palScreen(id: string, generation?: string): Promise<PalScreenView>
	openPalComputerStream?(id: string, generation: string): Promise<PalComputerStreamView>
	closePalComputerStream?(id: string): Promise<void>
	humanComputer?(): Promise<HumanComputerView>
	takeOverPalComputer?(id: string, generation: string): Promise<PalComputerView>
	returnPalComputerControl?(id: string, generation: string): Promise<PalComputerView>
	palComputerInput?(id: string, generation: string, input: PalComputerInput): Promise<void>
	openProject(): Promise<ProjectView | null>
	/**
	 * Takes a project out of Namzu: closes its connection, removes it from the list and from
	 * the trust list. Refused while work is running. Files and conversation journals stay.
	 */
	removeProject?(projectId: string): Promise<ProjectRemovalResult>
	/**
	 * Asks for the folder a missing project moved to, in the native picker, and keeps the
	 * project's conversations with it. Resolves null when the picker is cancelled.
	 */
	locateProject?(projectId: string): Promise<ProjectView | null>
	/** Adds a just-removed folder back (`token` came from the removal); a risky or broad one still asks. */
	restoreProject?(token: string): Promise<ProjectView>
	openChat?(): Promise<ProjectView>
	/** Creates a new project folder in Documents, trusted and open. */
	createProject?(): Promise<ProjectView>
	/** Adds a pending picked folder after the in-app trust dialog; `token` came from the pick. */
	trustFolder?(token: string): Promise<ProjectView>
	reconnectProject(projectId: string): Promise<ProjectView>
	trustProject(projectId: string, token?: string): Promise<ProjectView>
	conversations(projectId: string): Promise<ConversationView[]>
	newConversation(projectId: string): Promise<ConversationView>
	harnesses?(projectId: string, sessionId?: string): Promise<HarnessView>
	selectHarness?(sessionId: string, engine: HarnessView['selected']): Promise<HarnessView>
	openConversation(
		projectId: string,
		sessionId: string,
	): Promise<{
		messages: ChatMessage[]
		partial: boolean
		thread?: import('./projection.js').ThreadState
	}>
	/** Refresh tasks/retry state after history is visible, before admitting actions. */
	readyConversation?(projectId: string, sessionId: string): Promise<void>
	/** Durable title for a Namzu conversation; an empty title restores the automatic one. */
	renameConversation?(sessionId: string, title: string): Promise<ConversationView>
	/** Desktop-local pin; pinned conversations lead their project list and Recents. */
	setConversationPinned?(sessionId: string, pinned: boolean): Promise<ConversationView>
	/** Copies a Namzu conversation's history into a new conversation in the same project. */
	forkConversation?(sessionId: string): Promise<ConversationView>
	/** The conversation as Markdown, bounded to 4 MiB UTF-8. */
	conversationMarkdown?(sessionId: string): Promise<{ markdown: string; truncated: boolean }>
	/** Branch and last commit subject, or null when not a repository, untrusted or unavailable. */
	projectGit?(projectId: string): Promise<ProjectGitView | null>
	/** Remove a conversation from active lists; its durable journal remains readable. */
	removeConversation?(
		sessionId: string,
	): Promise<{ sessionId: string; removed: true; archived: boolean }>
	providers(projectId: string, sessionId?: string): Promise<ProviderView>
	models(projectId: string, provider: string, sessionId?: string): Promise<ModelCatalogueView>
	modelSettings(
		projectId: string,
		provider: string,
		model: string,
		sessionId?: string,
	): Promise<ComposerModelSettings>
	plugins(projectId: string, sessionId?: string): Promise<PluginInventoryView>
	setPluginEnabled(sessionId: string, name: string, enabled: boolean): Promise<PluginInventoryView>
	selectProvider(sessionId: string, provider: string, model?: string): Promise<void>
	pickAttachments(ownerId: string): Promise<AttachmentView[]>
	addAttachments(ownerId: string, files: AttachmentInput[]): Promise<AttachmentView[]>
	attachments(ownerId: string): Promise<AttachmentView[]>
	removeAttachment(ownerId: string, id: string): Promise<void>
	moveAttachments(fromOwner: string, toSessionId: string): Promise<AttachmentView[]>
	send(sessionId: string, prompt: string, options?: DesktopSendOptions): Promise<void>
	/** Text-only current-turn input when supported; otherwise uses the normal next-turn queue. */
	sendCurrent?(
		sessionId: string,
		prompt: string,
		options?: DesktopSendOptions,
	): Promise<'accepted' | 'queued'>
	retryTurn?(
		sessionId: string,
		turnId: string,
		checkpointId: string,
		options?: Omit<DesktopSendOptions, 'attachmentIds'>,
	): Promise<void>
	/** Per-reply file undo; absent when the CLI keeps no file history. State arrives as `undo-status` events. */
	undoStatus?(sessionId: string, turnIds?: string[]): Promise<void>
	undoPreview?(
		sessionId: string,
		turnId: string,
		options?: { alsoUndoLater?: boolean },
	): Promise<DesktopUndoPreview>
	undoTurn?(
		sessionId: string,
		turnId: string,
		planToken: string,
		options?: DesktopUndoOptions,
	): Promise<DesktopUndoResult>
	draft(sessionId: string): Promise<string>
	saveDraft(sessionId: string, draft: string): Promise<void>
	draftSettings(ownerId: string): Promise<DraftSettings>
	saveDraftSettings(ownerId: string, value: DraftSettings): Promise<void>
	cancel(sessionId: string): Promise<void>
	takeQueued(sessionId: string, itemId?: string): Promise<string | null>
	removeQueued(sessionId: string, itemId: string): Promise<void>
	respondPermission(
		sessionId: string,
		requestId: string,
		response: PermissionResponse,
	): Promise<void>
	jobs(sessionId: string): Promise<JobView[]>
	/** Metadata for already observed ordinary work; never admission or a job-output read. */
	backgroundWorkStatuses?(): Promise<Record<string, BackgroundWorkStatus>>
	/** Refresh the existing planning projection without starting a turn. */
	refreshTasks?(sessionId: string): Promise<void>
	readJob(sessionId: string, jobId: string): Promise<{ output: string; truncated?: boolean }>
	stopJob(sessionId: string, jobId: string): Promise<void>
	/** App updates. Absent in a preview that has no updater. */
	updateState?(): Promise<UpdateState>
	updateInfo?(): Promise<UpdateInfo>
	/** Fetch an update that was only offered because automatic download is off. */
	downloadUpdate?(): Promise<void>
	checkForUpdate?(): Promise<void>
	/** Restart now. A blocked install waits for the next idle moment until `cancelUpdateInstall`. */
	installUpdate?(): Promise<UpdateInstallResult>
	cancelUpdateInstall?(): Promise<void>
	reportUiBusy?(busy: UpdateUiBusy): Promise<void>
	onUpdateState?(listener: (state: UpdateState) => void): () => void
	/** The two external engines and a standalone Namzu CLI: versions and the update action. */
	engineUpdates?(): Promise<EngineUpdatesState>
	checkEngineUpdates?(): Promise<void>
	/** Runs the update in a visible terminal tab in the given pane; only ever for a click. */
	updateEngine?(request: EngineUpdateRequest): Promise<EngineUpdateResult>
	/** Versions found since the person was last told, each returned once across all windows. */
	claimEngineUpdateAnnouncements?(): Promise<EngineUpdateAnnouncement[]>
	onEngineUpdates?(listener: (state: EngineUpdatesState) => void): () => void
	onEngineUpdateNotice?(listener: (notice: EngineUpdateNotice) => void): () => void
	/** Terminal tabs. Absent in a preview with no host to run them. */
	terminals?(): Promise<TerminalTabView[]>
	terminalAvailability?(projectId: string): Promise<TerminalAvailability>
	/** The shells a plain terminal tab can open on this machine, for the setting. */
	terminalShells?(): Promise<TerminalShellChoice[]>
	/** Start a terminal in a project and open it as a tab in the given pane. */
	openTerminal?(request: TerminalOpenRequest): Promise<TerminalOpenResult>
	attachTerminal?(
		tabId: string,
		viewerId: string,
		options?: TerminalAttachOptions,
	): Promise<TerminalAttachView>
	detachTerminal?(tabId: string, viewerId: string): Promise<void>
	writeTerminal?(tabId: string, viewerId: string, data: string): Promise<void>
	resizeTerminal?(tabId: string, viewerId: string, cols: number, rows: number): Promise<void>
	/** End the terminal's whole process tree, forget it and close its tab. */
	closeTerminal?(tabId: string): Promise<void>
	/** Output and endings of the terminals this window has open. */
	onTerminalEvent?(listener: (event: TerminalEvent) => void): () => void
	onEvent(listener: (event: DesktopEvent) => void): () => void
}

export interface DesktopDiagnosticsView {
	path: string
	previousPath: string
	available: boolean
	notice?: string
}
declare global {
	interface Window {
		namzu: DesktopApi
	}
}
