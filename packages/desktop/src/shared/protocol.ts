import type { AcpSessionUpdate, PalAppearance, ReasoningEffort, ReviewMode } from '@namzu/sdk'

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
	choice?: { provider: string; model: string; label?: string }
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
}
export interface ConversationView {
	id: string
	projectId: string
	title: string
	updatedAt: string
	palId?: string
}
export interface ChatMessage {
	role: 'user' | 'assistant'
	text: string
	attachments?: AttachmentView[]
}
export interface ProviderView {
	available: { id: string; label: string; defaultModel: string }[]
	selected: { id: string; model?: string } | null
}
export interface ModelCatalogueView {
	models: { id: string; label: string; note?: string }[]
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
export interface PalComputerView {
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
export type DesktopEvent = (
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
	| { kind: 'permission-cleared'; sessionId: string; requestId?: string }
	| {
			kind: 'state'
			sessionId: string
			running: boolean
			queued: string[]
			queuedItems?: QueuedMessageView[]
			error?: string
	  }
	| { kind: 'connection'; project: ProjectView }
) & { readonly revision?: number }
export interface DesktopApi {
	windowChrome(): Promise<WindowChrome>
	setWindowAppearance(appearance: WindowAppearance): Promise<void>
	popupWindowMenu(menu: WindowMenu, anchor: WindowMenuAnchor): Promise<void>
	projects(): Promise<ProjectView[]>
	pals(): Promise<PalView[]>
	palProviders(): Promise<ProviderView>
	palModels(provider: string): Promise<ModelCatalogueView>
	createPal(input: PalInput): Promise<PalView>
	updatePal(id: string, expectedRevision: number, changes: Partial<PalChanges>): Promise<PalView>
	openPal(id: string): Promise<{
		pal: PalView
		project: ProjectView
		conversations: ConversationView[]
	}>
	palComputer(id: string): Promise<PalComputerView>
	startPalComputer(id: string): Promise<PalComputerView>
	stopPalComputer(id: string): Promise<PalComputerView>
	palScreen(id: string): Promise<PalScreenView>
	openProject(): Promise<ProjectView | null>
	reconnectProject(projectId: string): Promise<ProjectView>
	trustProject(projectId: string): Promise<ProjectView>
	conversations(projectId: string): Promise<ConversationView[]>
	newConversation(projectId: string): Promise<ConversationView>
	openConversation(
		projectId: string,
		sessionId: string,
	): Promise<{
		messages: ChatMessage[]
		partial: boolean
		thread?: import('./projection.js').ThreadState
	}>
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
	draft(sessionId: string): Promise<string>
	saveDraft(sessionId: string, draft: string): Promise<void>
	draftSettings(ownerId: string): Promise<DraftSettings>
	saveDraftSettings(ownerId: string, value: DraftSettings): Promise<void>
	cancel(sessionId: string): Promise<void>
	takeQueued(sessionId: string, itemId?: string): Promise<string | null>
	removeQueued(sessionId: string, itemId: string): Promise<void>
	approve(sessionId: string, requestId: string, approved: boolean): Promise<void>
	jobs(sessionId: string): Promise<JobView[]>
	readJob(sessionId: string, jobId: string): Promise<{ output: string; truncated?: boolean }>
	stopJob(sessionId: string, jobId: string): Promise<void>
	onEvent(listener: (event: DesktopEvent) => void): () => void
}
declare global {
	interface Window {
		namzu: DesktopApi
	}
}
