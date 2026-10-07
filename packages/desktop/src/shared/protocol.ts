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
	PalCommunicationView,
	PalPermissionChange,
	PalSubscriptionCreate,
	PalSubscriptionDisable,
} from './pal-communication-protocol.js'
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
	choice?: { provider: string; model: string; label?: string; preset?: 'default' }
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
	available: { id: string; label: string; defaultModel: string }[]
	selected: { id: string; model?: string } | null
}
export interface ModelCatalogueView {
	/** `default` marks this engine's own recommended default model. */
	models: { id: string; label: string; note?: string; default?: true }[]
	notice: string | null
}
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
export interface PalChanges extends PalInput {
	paused?: boolean
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
export interface PermissionView {
	id: string
	sessionId: string
	projectId: string
	calls: { id: string; name: string; input: unknown; isDestructive: boolean }[]
}
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
	| {
			kind: 'state'
			sessionId: string
			running: boolean
			liveInputSupported?: boolean
			queued: string[]
			queuedItems?: QueuedMessageView[]
			error?: string
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
export interface DesktopApi {
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
	windowChrome(): Promise<WindowChrome>
	setWindowAppearance(appearance: WindowAppearance): Promise<void>
	popupWindowMenu(menu: WindowMenu, anchor: WindowMenuAnchor): Promise<void>
	projects(): Promise<ProjectView[]>
	pals(): Promise<PalView[]>
	palProviders(): Promise<ProviderView>
	palModels(provider: string): Promise<ModelCatalogueView>
	createPal(input: PalInput): Promise<PalView>
	updatePal(id: string, expectedRevision: number, changes: Partial<PalChanges>): Promise<PalView>
	/** Retire the profile after confirmed guest cleanup; workspace files and journals remain. */
	deletePal?(id: string, expectedRevision: number): Promise<{ id: string; deleted: true }>
	palCommunication?(sessionId: string, palId: string): Promise<PalCommunicationView>
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
	openChat?(): Promise<ProjectView>
	reconnectProject(projectId: string): Promise<ProjectView>
	trustProject(projectId: string): Promise<ProjectView>
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
	draft(sessionId: string): Promise<string>
	saveDraft(sessionId: string, draft: string): Promise<void>
	draftSettings(ownerId: string): Promise<DraftSettings>
	saveDraftSettings(ownerId: string, value: DraftSettings): Promise<void>
	cancel(sessionId: string): Promise<void>
	takeQueued(sessionId: string, itemId?: string): Promise<string | null>
	removeQueued(sessionId: string, itemId: string): Promise<void>
	approve(sessionId: string, requestId: string, approved: boolean): Promise<void>
	jobs(sessionId: string): Promise<JobView[]>
	/** Metadata for already observed ordinary work; never admission or a job-output read. */
	backgroundWorkStatuses?(): Promise<Record<string, BackgroundWorkStatus>>
	/** Refresh the existing planning projection without starting a turn. */
	refreshTasks?(sessionId: string): Promise<void>
	readJob(sessionId: string, jobId: string): Promise<{ output: string; truncated?: boolean }>
	stopJob(sessionId: string, jobId: string): Promise<void>
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
