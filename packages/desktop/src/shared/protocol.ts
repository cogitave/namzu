import type { AcpSessionUpdate } from '@namzu/sdk'

export interface ProjectView {
	id: string
	path: string
	name: string
	trusted: boolean
	status: 'connecting' | 'ready' | 'error'
	error?: string
}
export interface ConversationView {
	id: string
	projectId: string
	title: string
	updatedAt: string
}
export interface ChatMessage {
	role: 'user' | 'assistant'
	text: string
}
export interface ProviderView {
	available: { id: string; label: string; defaultModel: string }[]
	selected: { id: string; model?: string } | null
}
export interface JobView {
	id: string
	command: string
	status: string
	startedAt: number
	exitCode?: number
}
export interface QueuedMessageView {
	id: string
	prompt: string
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
	| { kind: 'prompt'; sessionId: string; prompt: string }
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
	selectProvider(sessionId: string, provider: string, model?: string): Promise<void>
	send(sessionId: string, prompt: string): Promise<void>
	draft(sessionId: string): Promise<string>
	saveDraft(sessionId: string, draft: string): Promise<void>
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
