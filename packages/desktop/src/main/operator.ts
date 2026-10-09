import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type {
	AcpRequestPermissionParams,
	AcpSessionPromptResult,
	AcpSessionUpdateNotification,
} from '@namzu/sdk'
import type { BackgroundWorkStatus } from '../shared/background-work-protocol.js'
import { resolveComposerSendOptions } from '../shared/composer-send-options.js'
import { type HistoryWorkSnapshot, restoreHistoryWork } from '../shared/history-work.js'
import type {
	PalPermissionChange,
	PalSubscriptionCreate,
	PalSubscriptionDisable,
} from '../shared/pal-communication-protocol.js'
import { duplicatePalNameMessage, isDuplicatePalName } from '../shared/pal-name.js'
import { readPermissionCalls, readPermissionResponse } from '../shared/permission-protocol.js'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import type {
	AttachmentInput,
	AttachmentView,
	ChatMessage,
	ComposerModelSettings,
	ConversationView,
	DesktopEvent,
	DesktopRetryStatus,
	DesktopSendOptions,
	DesktopUndoOptions,
	DesktopUndoPreview,
	DesktopUndoResult,
	DraftSettings,
	EngineTimingReport,
	HarnessView,
	JobView,
	ModelCatalogueView,
	PalChanges,
	PalComputerInput,
	PalComputerStreamView,
	PalComputerView,
	PalCreateInput,
	PalInboxStartView,
	PalInput,
	PalScreenView,
	PalView,
	PermissionResponse,
	PermissionView,
	PluginInventoryView,
	ProjectChangeFile,
	ProjectChangesView,
	ProjectDiffView,
	ProjectFileContent,
	ProjectFileEntry,
	ProjectGitView,
	ProjectLinkResolution,
	ProjectRemovalResult,
	ProjectUntrust,
	ProjectView,
	ProviderConnectionView,
	ProviderTestResult,
	ProviderView,
} from '../shared/protocol.js'
import { readProviderConnections } from '../shared/provider-connections.js'
import { readTaskUpdate, readTasks } from '../shared/task-protocol.js'
import { readUndoPreview, readUndoResult, readUndoStatus } from '../shared/undo-protocol.js'
import type { UpdateBlocker } from '../shared/update-protocol.js'
import { AttachmentPreviewBudget } from './attachment-preview-budget.js'
import {
	type AdmittedAttachment,
	MAX_ATTACHMENT_COUNT,
	admitAttachment,
	readChosenFile,
	validateAttachmentBatch,
} from './attachments.js'
import { type BackgroundWorkOwner, BackgroundWorkStatusTracker } from './background-work-status.js'
import {
	type DesktopConversationSnapshot,
	DesktopConversationStore,
	type SavedLastModel,
} from './desktop-conversation-store.js'
import type { DesktopDiagnosticSink } from './diagnostics.js'
import { ModelListStore, type StoredModelList, modelListKey } from './model-list-store.js'
import { isNormalChatWorkspace, normalChatWorkspace } from './normal-chat-workspace.js'
import type { OpenIn, OpenTarget } from './open-in.js'
import { PalCommunicationManager } from './pal-communication.js'
import { palFolderToReveal } from './pal-folder.js'
import type { PalStreamProxy } from './pal-stream-proxy.js'
import { projectDraftOwner } from './project-draft-owner.js'
import { ProjectFiles, confineProjectPath, resolveProjectLinks } from './project-files.js'
import { parseUntrust, projectBusyReason, withoutProject } from './project-removal.js'
import { RuntimeClient, type RuntimeCommand } from './rpc-client.js'
import { SupersededConversationSettingsError } from './superseded-settings.js'
import type { FolderTrustGuard } from './trusted-folders.js'

interface PendingMessage {
	id: string
	prompt: string
	files: OwnedAttachment[]
	/** A status read failed, so this text requires an explicit edit before replay. */
	uncertainLiveInput?: boolean
	/** Authored edits and explicit clears fence first-prompt recovery. */
	draftRevision: number
	options?: Omit<DesktopSendOptions, 'attachmentIds'>
}
interface LiveInputReceipt {
	id: string
	prompt: string
	scopeId: string
	status: 'pending' | 'delivered'
	unknown?: boolean
	predecessors: string[]
	options?: Omit<DesktopSendOptions, 'attachmentIds'>
	draftRevision: number
}
interface LiveInputStatus {
	available: boolean
	scopeId?: string
	inputs: { id: string; status: 'pending' | 'delivered' }[]
}
function readLiveInputStatus(value: unknown): LiveInputStatus {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Namzu returned an invalid live input status.')
	const row = value as Record<string, unknown>
	if (
		typeof row.available !== 'boolean' ||
		(row.scopeId !== undefined &&
			(typeof row.scopeId !== 'string' || !row.scopeId || row.scopeId.length > 400)) ||
		!Array.isArray(row.inputs) ||
		row.inputs.length > 20 ||
		row.inputs.some(
			(item) =>
				!item ||
				typeof item !== 'object' ||
				typeof item.id !== 'string' ||
				!item.id ||
				item.id.length > 400 ||
				!['pending', 'delivered'].includes(item.status),
		)
	)
		throw new Error('Namzu returned an invalid live input status.')
	return row as unknown as LiveInputStatus
}
interface OwnedAttachment extends AdmittedAttachment {
	ownerId: string
	draft: boolean
}

interface Project {
	view: ProjectView
	client: RuntimeClient
	providers?: ProviderView
	/** Display metadata from this connection's authoritative catalogue; never history admission. */
	conversationCatalogue?: Map<string, ConversationView>
}
interface Conversation {
	view: ConversationView
	/** Stable UI ownership is separate from a replaceable, never-started runtime session. */
	runtimeSessionId: string
	hasPrompted: boolean
	reattaching?: Promise<void>
	/** A published replacement slot may need selection retry before it is ready. */
	replacement?: { client: RuntimeClient; id: string }
	/** Actual successful runtime choice, independent of unsubmitted composer settings. */
	providerSelection?: { provider: string; model?: string }
	providerSetupFailure?: string
	/** The host dropped under this conversation; its error line is cleared once Namzu reconnects. */
	connectionLost?: boolean
	selectionRevision?: number
	selectionPending?: boolean
	client: RuntimeClient
	running: boolean
	/** Exact owner of preflight or settlement; an older finally cannot release it. */
	admitting?: symbol
	executionRevision?: number
	runSettled?: Promise<void>
	queue: PendingMessage[]
	liveInputs?: Map<string, LiveInputReceipt>
	liveInputCalls?: Set<Promise<unknown>>
	liveInputRead?: Promise<LiveInputStatus | undefined>
	liveInputReadOnNextUpdate?: boolean
	liveInputRetry?: {
		id: string
		prompt: string
		scopeId: string
		draftRevision: number
		client: RuntimeClient
		runtimeId: string
		executionRevision: number
	}
	draft: string
	draftRevision?: number
	draftSettings?: DraftSettings
	providers?: ProviderView
	projection: ThreadState
	/** Full-list reads never overwrite a newer streamed task mutation. */
	taskRevision?: number
	taskRead?: Promise<boolean>
	tasksClient?: RuntimeClient
	readyRead?: {
		client: RuntimeClient
		runtimeId: string
		executionRevision: number
		selectionRevision: number
		promise: Promise<void>
	}
	needsLoad?: boolean
	needsHistory?: boolean
	historyRead?: {
		client: RuntimeClient
		runtimeId: string
		executionRevision: number
		selectionRevision: number
		promise: Promise<void>
	}
	restorePending?: boolean
	permissions: Map<string, string | number>
}
/** A stored model list older than this is read again in the background. */
const MODEL_LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000
// The CLI's own wording; only this notice describes the list rather than the conversation.
const MODEL_RETRY_AFTER_MS = 60 * 1000
const TRUNCATED_MODEL_NOTICE = 'Showing the first 4,096 models.'
interface ModelRead {
	view: ModelCatalogueView
	/** Present when the read was a usable list and is now stored. */
	entry?: StoredModelList
}
const CHANGE_STATUSES = new Set(['modified', 'added', 'deleted', 'renamed', 'untracked', 'binary'])

/** The host's changes answer, checked field by field; null when any part is malformed. */
export function checkedProjectChanges(value: unknown): ProjectChangesView | null {
	const raw = value as { files?: unknown; truncated?: unknown } | null
	if (
		!raw ||
		typeof raw !== 'object' ||
		!Array.isArray(raw.files) ||
		typeof raw.truncated !== 'boolean'
	)
		return null
	if (raw.files.length > 2_000) return null
	const pathOk = (path: unknown): path is string =>
		typeof path === 'string' &&
		path.length > 0 &&
		path.length <= 1_024 &&
		withoutControls(path) === path
	const count = (n: unknown): n is number =>
		typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
	const files: ProjectChangeFile[] = []
	for (const entry of raw.files as Record<string, unknown>[]) {
		if (
			!entry ||
			typeof entry !== 'object' ||
			!pathOk(entry.path) ||
			typeof entry.status !== 'string' ||
			!CHANGE_STATUSES.has(entry.status) ||
			!count(entry.added) ||
			!count(entry.removed) ||
			(entry.oldPath !== undefined && !pathOk(entry.oldPath))
		)
			return null
		files.push({
			path: entry.path,
			status: entry.status as ProjectChangeFile['status'],
			added: entry.added,
			removed: entry.removed,
			...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath as string }),
		})
	}
	return { files, truncated: raw.truncated }
}

/** One control-character filter for titles and git strings: C0, DEL and C1. */
function withoutControls(value: string): string {
	return Array.from(value)
		.filter((character) => {
			const code = character.codePointAt(0) as number
			return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)
		})
		.join('')
}
function withoutPin(view: ConversationView): ConversationView {
	const { pinned: _pinned, ...rest } = view
	return rest
}
export class Operator {
	private readonly communication: PalCommunicationManager
	private communicationScope(sessionId: string, palId: string) {
		const session = this.session(sessionId)
		const project = this.project(session.view.projectId)
		const client = project.client
		const runtimeSessionId = session.runtimeSessionId
		const revision = this.palRecords.get(palId)?.revision
		const assertCurrent = () => {
			this.assertPalAvailable(palId)
			if (this.changingPals.has(palId)) throw new Error('Wait for this Pal’s changes to finish.')
			if (
				this.closing ||
				this.conversations.get(sessionId) !== session ||
				session.view.palId !== palId ||
				project.view.palId !== palId ||
				this.projects.get(project.view.id) !== project ||
				project.view.status !== 'ready' ||
				project.client !== client ||
				session.client !== client ||
				session.runtimeSessionId !== runtimeSessionId ||
				this.palRecords.get(palId)?.revision !== revision
			)
				throw new Error('This Pal conversation changed. Open Communication again.')
		}
		assertCurrent()
		return { client, runtimeSessionId, assertCurrent }
	}
	palCommunication(sessionId: string, palId: string) {
		return this.communication.read(sessionId, palId)
	}
	palInbox(sessionId: string, palId: string) {
		return this.communication.inbox(sessionId, palId)
	}
	updatePalPermission(sessionId: string, palId: string, change: PalPermissionChange) {
		return this.changePalCommunication(palId, () =>
			this.communication.updatePermission(sessionId, palId, change),
		)
	}
	createPalSubscription(sessionId: string, palId: string, input: PalSubscriptionCreate) {
		return this.changePalCommunication(palId, () =>
			this.communication.createSubscription(sessionId, palId, input),
		)
	}
	disablePalSubscription(sessionId: string, palId: string, input: PalSubscriptionDisable) {
		return this.changePalCommunication(palId, () =>
			this.communication.disableSubscription(sessionId, palId, input),
		)
	}
	private async changePalCommunication<T>(palId: string, change: () => Promise<T>): Promise<T> {
		this.assertPalAvailable(palId)
		if (this.changingPals.has(palId) || this.changingPalCommunication.has(palId))
			throw new Error('Wait for this Pal’s changes to finish.')
		this.changingPalCommunication.add(palId)
		try {
			return await change()
		} finally {
			this.changingPalCommunication.delete(palId)
		}
	}
	private closing = false
	private registryClient?: RuntimeClient
	private registryStarting?: Promise<RuntimeClient>
	private chatStarting?: Promise<ProjectView>
	/** Retain shutdown authority even when a disconnected client leaves its UI slot. */
	private readonly ownedClients = new Set<RuntimeClient>()
	private readonly palRecords = new Map<string, PalView>()
	private readonly computerAuthorityEpochs = new Map<string, number>()
	private readonly operatorComputers = new Map<string, string>()
	private readonly computerViewers = new Map<
		string,
		{ palId: string; client: RuntimeClient; onClosed: () => void }
	>()
	private readonly changingPals = new Set<string>()
	private readonly changingPalCommunication = new Set<string>()
	private readonly deletedPals = new Map<string, number>()
	private readonly deletingPals = new Map<
		string,
		{ expectedRevision: number; projectIds: string[]; sessionIds: string[] }
	>()
	private readonly openingPals = new Map<string, number>()
	private readonly startingPalComputers = new Set<string>()
	private readonly startingPalConversations = new Map<string, number>()
	private readonly archivingConversations = new Set<string>()
	private readonly pendingConversationRemovals = new Set<string>()
	private readonly removedConversations = new Map<string, boolean>()
	private readonly projectFiles = new ProjectFiles()
	/** Archived rows last shown per project, so a restore knows which project owns the id. */
	private readonly archivedOwners = new Map<string, string>()
	private readonly projects = new Map<string, Project>()
	private readonly removingProjects = new Set<string>()
	private readonly projectStarting = new Map<string, Promise<ProjectView>>()
	private readonly conversations = new Map<string, Conversation>()
	private readonly projectDrafts = new Map<
		string,
		{ draft: string; draftSettings?: DraftSettings }
	>()
	private readonly attachmentFiles = new Map<string, OwnedAttachment>()
	private readonly attachmentPreviews = new AttachmentPreviewBudget()
	private readonly changingPlugins = new Set<string>()
	private readonly backgroundWork: BackgroundWorkStatusTracker
	private readonly desktopStore?: DesktopConversationStore
	private readonly modelLists?: ModelListStore
	private readonly modelReads = new Map<string, Promise<ModelRead>>()
	/** Keys read from the CLI in this app run, so a stored list is revalidated once per launch. */
	private readonly modelsRevalidated = new Set<string>()
	/** Keys whose list the CLI contradicted; the next read refreshes them regardless of age. */
	private readonly modelsStale = new Set<string>()
	/** When a failed background read may be tried again, per key. */
	private readonly modelsRetryAt = new Map<string, number>()
	private savedDesktop?: DesktopConversationSnapshot
	/** The model last picked per engine; a new conversation of that engine starts from it. */
	private readonly lastModels = new Map<string, SavedLastModel>()
	/** Pals with a message from the person they have not opened; survives a restart. */
	private readonly unreadPals = new Set<string>()
	constructor(
		private readonly command: RuntimeCommand,
		private readonly publish: (event: DesktopEvent) => void,
		private readonly registryDirectory?: string,
		private readonly diagnostics?: DesktopDiagnosticSink,
		private readonly streamProxy?: Pick<PalStreamProxy, 'onClosed' | 'open' | 'close'>,
		private readonly openIn?: Pick<OpenIn, 'editors' | 'open'>,
		private readonly folderGuard?: FolderTrustGuard,
		private readonly options: { autoReconnect?: boolean } = {},
	) {
		this.backgroundWork = new BackgroundWorkStatusTracker((event) => this.publish(event))
		this.communication = new PalCommunicationManager(
			this.communicationScope.bind(this),
			diagnostics,
		)
		streamProxy?.onClosed((id) => this.closePalComputerStream(id))
		if (registryDirectory) {
			this.modelLists = new ModelListStore(registryDirectory, {
				onError: (error) => diagnostics?.record('ipc_failed', { operation: 'models', error }),
			})
			this.desktopStore = new DesktopConversationStore(registryDirectory)
			try {
				this.savedDesktop = this.desktopStore.read()
				for (const item of this.savedDesktop?.projectDrafts ?? [])
					this.projectDrafts.set(item.ownerId, {
						draft: item.draft,
						...(item.draftSettings ? { draftSettings: structuredClone(item.draftSettings) } : {}),
					})
				for (const [engine, item] of Object.entries(this.savedDesktop?.lastModels ?? {}))
					this.lastModels.set(engine, { ...item })
				for (const palId of this.savedDesktop?.unreadPals ?? []) this.unreadPals.add(palId)
				for (const item of this.savedDesktop?.attachments ?? [])
					this.attachmentFiles.set(item.view.id, structuredClone(item))
			} catch (error) {
				diagnostics?.record('project_restore_failed', { error })
			}
		}
	}
	/**
	 * What keeps an app update from restarting the process right now. A status that is only
	 * unknown or unavailable is not a reason: an engine that cannot report is covered while it runs.
	 */
	updateBlockers(): UpdateBlocker[] {
		const found = new Set<UpdateBlocker>()
		for (const item of this.conversations.values()) {
			if (item.running || item.admitting || item.queue.length) found.add('turn-running')
			if (item.permissions.size) found.add('permission-pending')
		}
		for (const status of Object.values(this.backgroundWork.snapshot()))
			if (status.state === 'known' && status.runningCount > 0) found.add('background-work')
		return [...found]
	}
	/** Whether a conversation on this engine has a reply running, queued, or a permission waiting. */
	engineBusy(engine: 'codex-cli' | 'claude-code'): boolean {
		for (const item of this.conversations.values())
			if (
				item.view.harness === engine &&
				(item.running || item.admitting || item.queue.length || item.permissions.size)
			)
				return true
		return false
	}
	/**
	 * Ends the idle servers every project's runtime keeps for this engine, so an update can replace
	 * its program. A runtime that is gone, or too old to know the call, is skipped.
	 */
	async releaseEngine(engine: 'codex-cli' | 'claude-code'): Promise<void> {
		await Promise.all(
			[...this.projects.values()].map(async (project) => {
				if (project.view.status !== 'ready' || project.view.palId) return
				try {
					await project.client.request('namzu/harnesses/release', { engine })
				} catch (error) {
					this.diagnostics?.record('cli_request_failed', {
						operation: 'releaseEngine',
						error,
					})
				}
			}),
		)
	}
	/**
	 * The engine's program changed on disk: every stored model list for it is dropped and the next
	 * read asks the new build. Open pickers read again.
	 */
	engineUpdated(engine: 'codex-cli' | 'claude-code'): void {
		this.modelLists?.forgetEngine(engine)
		for (const set of [this.modelsRevalidated, this.modelsStale])
			for (const key of [...set]) if (key.startsWith(`${engine}/`)) set.delete(key)
		for (const key of [...this.modelsRetryAt.keys()])
			if (key.startsWith(`${engine}/`)) this.modelsRetryAt.delete(key)
		this.emit({ kind: 'model-catalogue-updated', engine, provider: engine })
	}
	/** Volatile UI knowledge. Missing entries are unknown, never zero. */
	backgroundWorkStatuses(): Record<string, BackgroundWorkStatus> {
		const statuses = this.backgroundWork.snapshot()
		for (const session of this.conversations.values()) {
			if (session.view.palId) continue
			if (session.view.harness === 'codex-cli' || session.view.harness === 'claude-code')
				statuses[session.view.id] = { state: 'unavailable' }
		}
		return statuses
	}
	/** Observe only an exact connected ordinary Namzu owner. */
	trackBackgroundWork(sessionId: string): void {
		const session = this.conversations.get(sessionId)
		if (!session || session.view.palId || !session.hasPrompted) {
			this.backgroundWork.invalidate(sessionId)
			return
		}
		if (session.view.harness === 'codex-cli' || session.view.harness === 'claude-code') {
			this.backgroundWork.invalidate(sessionId, { state: 'unavailable' })
			return
		}
		const project = this.projects.get(session.view.projectId)
		if (
			!project ||
			project.view.status !== 'ready' ||
			!project.view.trusted ||
			session.client !== project.client
		) {
			this.backgroundWork.invalidate(sessionId)
			return
		}
		const client = project.client
		const runtimeSessionId = session.runtimeSessionId
		const owner: BackgroundWorkOwner = {
			projectId: project.view.id,
			sessionId,
			runtimeSessionId,
			connection: client,
		}
		const current = () =>
			!this.closing &&
			this.projects.get(project.view.id) === project &&
			project.view.status === 'ready' &&
			project.view.trusted &&
			this.conversations.get(sessionId) === session &&
			session.client === client &&
			session.runtimeSessionId === runtimeSessionId &&
			session.hasPrompted &&
			!session.view.palId &&
			(!session.view.harness || session.view.harness === 'namzu')
		this.backgroundWork.observe(
			owner,
			() => client.request('namzu/jobs/list', { sessionId: runtimeSessionId }, 8_000),
			current,
		)
	}
	/** Private desktop metadata restores view/draft identities; submitted prompts are never replayed. */
	private persistDesktop(reportOnly = false): void {
		if (!this.desktopStore) return
		const projects = new Map((this.savedDesktop?.projects ?? []).map((item) => [item.id, item]))
		for (const { view } of this.projects.values())
			projects.set(view.id, { id: view.id, path: view.path })
		const conversations = new Map(
			(this.savedDesktop?.conversations ?? []).map((item) => [item.view.id, item]),
		)
		for (const item of this.conversations.values())
			conversations.set(item.view.id, {
				view: { ...item.view },
				runtimeSessionId: item.runtimeSessionId,
				hasPrompted:
					!!item.needsHistory ||
					(item.hasPrompted &&
						(!item.view.palId ||
							item.projection.messages.some((message) => message.role === 'user'))),
				draft: item.draft,
				...(item.draftSettings ? { draftSettings: structuredClone(item.draftSettings) } : {}),
				...(item.providerSelection ? { providerSelection: { ...item.providerSelection } } : {}),
			})
		const snapshot: DesktopConversationSnapshot = {
			version: 1,
			projects: [...projects.values()],
			conversations: [...conversations.values()],
			projectDrafts: [...this.projectDrafts].map(([ownerId, item]) => ({
				ownerId,
				...structuredClone(item),
			})),
			...(this.lastModels.size ? { lastModels: Object.fromEntries(this.lastModels) } : {}),
			...(this.unreadPals.size ? { unreadPals: [...this.unreadPals] } : {}),
			attachments: [...this.attachmentFiles.values()]
				.filter((item) => item.draft)
				.map((item) => ({ ...item, draft: true as const })),
		}
		try {
			this.desktopStore.write(snapshot)
			this.savedDesktop = snapshot
		} catch (error) {
			this.diagnostics?.record('ipc_failed', { operation: 'saveDraft', error })
			if (reportOnly) return
			throw new Error('Namzu could not save desktop drafts. Check diagnostic storage and retry.')
		}
	}
	restoredProjectPaths(
		tabIds: readonly string[],
		alsoProjectIds: readonly string[] = [],
	): string[] {
		const selected = new Set(tabIds)
		const projects = new Set([
			...(this.savedDesktop?.conversations ?? [])
				.filter((item) => selected.has(item.view.id))
				.map((item) => item.view.projectId),
			...alsoProjectIds,
		])
		return (this.savedDesktop?.projects ?? [])
			.filter((item) => projects.has(item.id))
			.map((item) => item.path)
	}
	private async closeClient(client: RuntimeClient): Promise<void> {
		for (const [id, viewer] of this.computerViewers)
			if (viewer.client === client) this.closePalComputerStream(id)
		await client.close()
		this.ownedClients.delete(client)
	}
	private async registry(requirePals = true): Promise<RuntimeClient> {
		const client = await this.startRegistry()
		if (requirePals && !client.supportsPals())
			throw new Error('Update Namzu to a version that supports Pals.')
		return client
	}
	private async startRegistry(): Promise<RuntimeClient> {
		if (this.closing) throw new Error('Namzu is closing.')
		if (this.registryClient) return this.registryClient
		if (this.registryStarting) return this.registryStarting
		const operation = (async () => {
			const cwd = this.registryDirectory ?? process.cwd()
			await mkdir(cwd, { recursive: true, mode: 0o700 })
			if (this.closing) throw new Error('Namzu is closing.')
			const client = new RuntimeClient(cwd, this.command, this.diagnostics)
			this.ownedClients.add(client)
			client.on('closed', () => {
				if (this.registryClient === client) this.registryClient = undefined
			})
			try {
				await client.start()
				if (this.closing) throw new Error('Namzu is closing.')
				this.registryClient = client
				return client
			} catch (error) {
				await this.closeClient(client)
				throw error
			}
		})()
		this.registryStarting = operation
		try {
			return await operation
		} finally {
			if (this.registryStarting === operation) this.registryStarting = undefined
		}
	}
	async listPals(): Promise<PalView[]> {
		const client = await this.registry()
		const pals = (await client.request('namzu/pals/list')) as PalView[]
		if (!Array.isArray(pals)) throw new Error('Namzu returned an invalid Pal list.')
		const available = pals.filter((pal) => !this.deletedPals.has(pal.id))
		for (const pal of available) this.palRecords.set(pal.id, pal)
		return available
	}
	/** The Pals that have a message from the person they have not opened yet. */
	palUnread(): string[] {
		return [...this.unreadPals].filter((id) => !this.deletedPals.has(id))
	}
	/** Marks one Pal unread (a message was delivered) or read (its conversation was opened). */
	setPalUnread(id: unknown, unread: unknown): string[] {
		if (typeof id !== 'string' || !id.trim() || id.length > 400 || typeof unread !== 'boolean')
			throw new Error('Invalid Pal.')
		// The saved file rejects control characters in an id; one stored here would make the whole
		// file unreadable on the next start and lose every saved draft.
		if (Array.from(id).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
			throw new Error('Invalid Pal.')
		if (unread) {
			if (this.deletedPals.has(id) || this.unreadPals.has(id)) return this.palUnread()
			if (this.unreadPals.size >= 1024) throw new Error('Too many Pals are marked unread.')
			this.unreadPals.add(id)
		} else if (!this.unreadPals.delete(id)) return this.palUnread()
		this.persistDesktop(true)
		return this.palUnread()
	}
	/** The folder to reveal for one Pal; the Pal is named by id and the path comes from main's own record. */
	async palFolder(id: string): Promise<string> {
		if (typeof id !== 'string' || !id.trim() || id.length > 400) throw new Error('Invalid Pal.')
		if (this.deletedPals.has(id)) throw new Error('This Pal was deleted.')
		let pal = this.palRecords.get(id)
		if (!pal) pal = (await (await this.registry()).request('namzu/pals/get', { id })) as PalView
		if (!pal || pal.id !== id) throw new Error('This Pal is unavailable.')
		return palFolderToReveal(pal.workspace)
	}
	async palProviders(): Promise<ProviderView> {
		return (await (await this.registry()).request('namzu/providers/status')) as ProviderView
	}
	private async providerHost(): Promise<RuntimeClient> {
		const client = await this.registry(false)
		if (!client.supportsProviderSetup())
			throw new Error('Update Namzu to a version that can connect providers.')
		return client
	}
	async providerConnections(): Promise<ProviderConnectionView[]> {
		const client = await this.providerHost()
		return readProviderConnections(await client.request('namzu/providers/connections'))
	}
	/** The key goes straight to the CLI's private store; this process neither keeps nor logs it. */
	async saveProviderKey(provider: unknown, apiKey: unknown): Promise<ProviderConnectionView[]> {
		if (typeof provider !== 'string' || !provider.trim() || provider.length > 400)
			throw new Error('Choose a provider.')
		if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Paste an API key.')
		if (apiKey.length > 4096) throw new Error('That is too long to be an API key.')
		const client = await this.providerHost()
		await client.request('namzu/providers/save_key', { provider, apiKey: apiKey.trim() })
		return this.providersChanged(client)
	}
	async removeProviderKey(provider: unknown): Promise<ProviderConnectionView[]> {
		if (typeof provider !== 'string' || !provider.trim() || provider.length > 400)
			throw new Error('Choose a provider.')
		const client = await this.providerHost()
		await client.request('namzu/providers/remove_key', { provider })
		return this.providersChanged(client)
	}
	async testProvider(provider: unknown): Promise<ProviderTestResult> {
		if (typeof provider !== 'string' || !provider.trim() || provider.length > 400)
			throw new Error('Choose a provider.')
		const client = await this.providerHost()
		const result = (await client.request('namzu/providers/test', { provider }, 45_000)) as {
			status?: unknown
		}
		return result?.status === 'ok' ||
			result?.status === 'rejected' ||
			result?.status === 'missing' ||
			result?.status === 'unchecked'
			? result.status
			: 'unchecked'
	}
	/** Every open project host and every window must see the new set of providers. */
	private async providersChanged(registry: RuntimeClient): Promise<ProviderConnectionView[]> {
		const clients = new Set<RuntimeClient>()
		for (const project of this.projects.values()) {
			project.providers = undefined
			if (project.view.status === 'ready' && project.client.supportsProviderSetup())
				clients.add(project.client)
		}
		for (const session of this.conversations.values()) session.providers = undefined
		clients.delete(registry)
		await Promise.allSettled(
			[...clients].map((client) => client.request('namzu/providers/refresh', {}, 10_000)),
		)
		this.emit({ kind: 'providers-changed' })
		return readProviderConnections(await registry.request('namzu/providers/connections'))
	}
	async palModels(provider: string): Promise<ModelCatalogueView> {
		if (typeof provider !== 'string' || !provider.trim() || provider.length > 400)
			throw new Error('Invalid provider.')
		return (await (
			await this.registry()
		).request('namzu/providers/models', {
			provider,
		})) as ModelCatalogueView
	}
	/** Creates in flight and recently finished, by attempt id: a repeated id never makes a second Pal. */
	private readonly creatingPals = new Map<string, Promise<PalView>>()
	private readonly createdPals = new Map<string, PalView>()
	async createPal(input: PalCreateInput): Promise<PalView> {
		const { requestId, ...fields } = input
		if (
			requestId !== undefined &&
			(typeof requestId !== 'string' || !requestId || requestId.length > 100)
		)
			throw new Error('Invalid Pal request.')
		if (requestId) {
			const done = this.createdPals.get(requestId)
			if (done) return done
			const flight = this.creatingPals.get(requestId)
			if (flight) return flight
		}
		const operation = this.createNewPal(fields)
		if (!requestId) return operation
		this.creatingPals.set(requestId, operation)
		try {
			const pal = await operation
			this.createdPals.set(requestId, pal)
			// Only the latest attempts are kept; a repeat comes within moments of the first.
			while (this.createdPals.size > 32) {
				const oldest = this.createdPals.keys().next().value
				if (oldest === undefined) break
				this.createdPals.delete(oldest)
			}
			return pal
		} finally {
			this.creatingPals.delete(requestId)
		}
	}
	private async createNewPal(input: PalInput): Promise<PalView> {
		if (typeof input?.name === 'string') {
			const names = [...this.palRecords.values()]
				.filter((item) => !this.deletedPals.has(item.id))
				.map((item) => item.name)
			if (isDuplicatePalName(input.name, names))
				throw new Error(duplicatePalNameMessage(input.name, names))
		}
		const pal = (await (
			await this.registry()
		).request('namzu/pals/create', { ...input })) as PalView
		this.palRecords.set(pal.id, pal)
		return pal
	}
	async updatePal(
		id: string,
		expectedRevision: number,
		changes: Partial<PalChanges>,
	): Promise<PalView> {
		this.assertPalAvailable(id)
		if (typeof id !== 'string' || this.changingPals.has(id))
			throw new Error('Wait for this Pal’s changes to finish.')
		this.changingPals.add(id)
		try {
			const owned = [...this.conversations.values()].filter((item) => item.view.palId === id)
			if (owned.some((item) => item.running || item.queue.length || item.permissions.size))
				throw new Error('Stop this Pal’s active work before changing it.')
			for (const item of owned) {
				const jobs = (await this.jobs(item.view.id)) as JobView[]
				if (!Array.isArray(jobs) || jobs.some((job) => job.status === 'running'))
					throw new Error('Stop this Pal’s background work before changing it.')
			}
			const pal = (await (
				await this.registry()
			).request('namzu/pals/update', {
				...changes,
				id,
				expectedRevision,
			})) as PalView
			this.palRecords.set(pal.id, pal)
			return pal
		} finally {
			this.changingPals.delete(id)
		}
	}
	private assertPalAvailable(id: string): void {
		if (typeof id !== 'string' || !id.trim() || id.length > 400) throw new Error('Invalid Pal.')
		if (this.deletedPals.has(id)) throw new Error('This Pal was deleted.')
		if (this.deletingPals.has(id))
			throw new Error('This Pal deletion needs confirmation. Retry deleting it.')
	}
	private assertPalDeletionIdle(id: string, workspace?: string): void {
		this.assertPalComputerForegroundIdle(id)
		if (
			this.openingPals.has(id) ||
			this.startingPalComputers.has(id) ||
			this.startingPalConversations.has(id) ||
			this.changingPalCommunication.has(id) ||
			(workspace && this.projectStarting.has(workspace)) ||
			[...this.conversations.values()].some(
				(item) =>
					item.view.palId === id &&
					(item.reattaching ||
						item.selectionPending ||
						this.changingPlugins.has(item.view.id) ||
						this.archivingConversations.has(item.view.id) ||
						this.pendingConversationRemovals.has(item.view.id)),
			)
		)
			throw new Error('Wait for this Pal’s connection or settings change to finish.')
	}
	async deletePal(id: string, expectedRevision: number): Promise<{ id: string; deleted: true }> {
		if (
			typeof id !== 'string' ||
			!id.trim() ||
			id.length > 400 ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 1
		)
			throw new Error('Invalid Pal deletion.')
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		const deletedRevision = this.deletedPals.get(id)
		if (deletedRevision !== undefined) {
			if (deletedRevision !== expectedRevision) throw new Error('This Pal changed. Refresh it.')
			return { id, deleted: true }
		}
		this.changingPals.add(id)
		this.advanceComputerAuthority(id)
		try {
			const registry = await this.registry()
			let scope = this.deletingPals.get(id)
			if (scope && scope.expectedRevision !== expectedRevision)
				throw new Error('This Pal changed. Refresh it.')
			if (!scope) {
				const current = (await registry.request('namzu/pals/get', {
					id,
				})) as PalView
				if (!current || current.id !== id || current.revision !== expectedRevision)
					throw new Error('This Pal changed. Refresh it before deleting.')
				this.assertPalDeletionIdle(id, current.workspace)
				const client = await this.controlClient(id, true)
				this.assertPalDeletionIdle(id, current.workspace)
				const computer = await this.computerStatus(client, id)
				if (computer.control?.mode === 'transitioning')
					throw new Error('Wait for this Pal computer’s control change to finish.')
				const projects = [...this.projects.values()].filter((item) => item.view.palId === id)
				const owned = [...this.conversations.values()].filter((item) => item.view.palId === id)
				const claimed = (await client.request('namzu/pals/conversations/list', {
					palId: id,
				})) as {
					id: string
				}[]
				if (!Array.isArray(claimed) || claimed.some((item) => !item || typeof item.id !== 'string'))
					throw new Error('This Pal’s background work could not be verified.')
				const runtimeIds = new Set([
					...claimed.map((item) => item.id),
					...owned.map((item) => item.runtimeSessionId),
				])
				for (const sessionId of runtimeIds) {
					const jobs = (await client.request('namzu/jobs/list', {
						sessionId,
					})) as JobView[]
					if (
						!Array.isArray(jobs) ||
						jobs.some(
							(job) =>
								!job ||
								typeof job.status !== 'string' ||
								job.status === 'running' ||
								job.recoveryRequired,
						)
					)
						throw new Error('Stop this Pal’s background work before deleting it.')
				}
				const latest = (await registry.request('namzu/pals/get', {
					id,
				})) as PalView
				if (
					!latest ||
					latest.id !== id ||
					latest.revision !== expectedRevision ||
					latest.workspace !== current.workspace
				)
					throw new Error('This Pal changed. Refresh it before deleting.')
				this.assertPalDeletionIdle(id, current.workspace)
				if (
					!this.ownedClients.has(client) ||
					!projects.some(
						(item) => item.client === client && this.projects.get(item.view.id) === item,
					)
				)
					throw new Error('This Pal’s connection changed before deleting.')
				const stopped = await this.stopOwnedPalComputer(id, client)
				if (stopped.status !== 'stopped' || stopped.requiresStop)
					throw new Error('The Pal computer did not confirm its stop. Recover it before deleting.')
				this.assertPalDeletionIdle(id, current.workspace)
				for (const ownedClient of new Set(projects.map((item) => item.client)))
					await this.closeClient(ownedClient)
				scope = {
					expectedRevision,
					projectIds: projects.map((item) => item.view.id),
					sessionIds: [
						...new Set([
							...claimed.map((item) => item.id),
							...owned.map((item) => item.view.id),
							...(this.savedDesktop?.conversations ?? [])
								.filter((item) => item.view.palId === id)
								.map((item) => item.view.id),
						]),
					],
				}
				// An uncertain metadata acknowledgement may be retried at the same
				// revision. It never reopens a guest or admits work before confirmation.
				this.deletingPals.set(id, scope)
			}
			const result = (await registry.request('namzu/pals/delete', {
				id,
				expectedRevision,
			})) as {
				id?: unknown
				deleted?: unknown
			}
			if (!result || result.id !== id || result.deleted !== true)
				throw new Error('Pal deletion was not confirmed. Retry deleting it.')
			this.deletedPals.set(id, expectedRevision)
			this.deletingPals.delete(id)
			this.palRecords.delete(id)
			this.unreadPals.delete(id)
			for (const sessionId of scope.sessionIds) this.backgroundWork.invalidate(sessionId)
			for (const projectId of scope.projectIds) this.projects.delete(projectId)
			for (const sessionId of scope.sessionIds) {
				this.conversations.delete(sessionId)
				this.attachmentPreviews.forget(sessionId)
			}
			const retiredOwners = new Set(scope.sessionIds)
			for (const ownerId of this.projectDrafts.keys()) {
				const owner = projectDraftOwner(ownerId)
				if (owner && scope.projectIds.includes(owner.projectId)) {
					retiredOwners.add(ownerId)
					this.projectDrafts.delete(ownerId)
				}
			}
			for (const [attachmentId, file] of this.attachmentFiles)
				if (retiredOwners.has(file.ownerId)) this.attachmentFiles.delete(attachmentId)
			if (this.savedDesktop)
				this.savedDesktop = {
					...this.savedDesktop,
					projects: this.savedDesktop.projects.filter(
						(item) => !scope.projectIds.includes(item.id),
					),
					conversations: this.savedDesktop.conversations.filter((item) => item.view.palId !== id),
				}
			this.persistDesktop(true)
			this.emit({
				kind: 'pal-deleted',
				palId: id,
				projectIds: scope.projectIds,
				sessionIds: scope.sessionIds,
			})
			return { id, deleted: true }
		} finally {
			this.advanceComputerAuthority(id)
			this.changingPals.delete(id)
		}
	}
	async openPal(id: string): Promise<{
		pal: PalView
		project: ProjectView
		conversations: ConversationView[]
	}> {
		this.assertPalAvailable(id)
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		this.openingPals.set(id, (this.openingPals.get(id) ?? 0) + 1)
		try {
			return await this.openOwnedPal(id)
		} finally {
			const remaining = (this.openingPals.get(id) ?? 1) - 1
			if (remaining) this.openingPals.set(id, remaining)
			else this.openingPals.delete(id)
		}
	}
	private async openOwnedPal(id: string): Promise<{
		pal: PalView
		project: ProjectView
		conversations: ConversationView[]
	}> {
		this.assertPalAvailable(id)
		const pal = (await (await this.registry()).request('namzu/pals/get', { id })) as PalView
		this.assertPalAvailable(id)
		if (!pal || pal.id !== id) throw new Error('This Pal is unavailable.')
		this.palRecords.set(pal.id, pal)
		const view = await this.openProjectDirectory(pal.workspace, true)
		const project = this.projects.get(view.id)
		if (!project) throw new Error('This Pal could not connect its local workspace.')
		const assertConnected = () => {
			this.assertPalAvailable(id)
			if (this.closing || this.projects.get(view.id) !== project)
				throw new Error('This Pal’s connection changed while opening. Reopen it.')
			if (project.view.status !== 'ready')
				throw new Error(project.view.error ?? 'This Pal could not connect its local workspace.')
			if (
				!project.view.trusted ||
				project.view.palId !== pal.id ||
				project.view.path !== pal.workspace
			)
				throw new Error('This Pal’s workspace ownership could not be verified.')
		}
		assertConnected()
		project.view.palId = pal.id
		project.view.name = pal.name
		let conversations: ConversationView[]
		try {
			conversations = await this.listConversations(view.id)
		} catch (error) {
			assertConnected()
			throw error
		}
		assertConnected()
		return {
			pal,
			project: { ...project.view },
			conversations,
		}
	}
	async palComputer(id: string): Promise<PalComputerView> {
		return this.computerStatus(await this.controlClient(id, true), id)
	}
	private advanceComputerAuthority(id: string): void {
		this.computerAuthorityEpochs.set(id, (this.computerAuthorityEpochs.get(id) ?? 0) + 1)
	}
	private async computerStatus(client: RuntimeClient, id: string): Promise<PalComputerView> {
		const epoch = this.computerAuthorityEpochs.get(id) ?? 0
		const state = (await client.request('namzu/pals/computer/status', {
			palId: id,
		})) as PalComputerView
		if (!client.supportsPalComputerControl())
			return { ...state, control: { supported: false, mode: 'unavailable' } }
		if (
			this.closing ||
			this.changingPals.has(id) ||
			epoch !== (this.computerAuthorityEpochs.get(id) ?? 0)
		)
			return state
		if (state.control?.mode === 'operator' && state.generation)
			this.operatorComputers.set(id, state.generation)
		else if (state.control?.mode === 'pal' || state.status === 'stopped')
			this.operatorComputers.delete(id)
		return state
	}
	private async controlClient(id: string, reuseReady: boolean): Promise<RuntimeClient> {
		if (this.closing) throw new Error('Namzu is closing.')
		this.assertPalAvailable(id)
		if (reuseReady) {
			const owned = [...this.projects.values()].find(
				({ view, client }) =>
					view.palId === id &&
					view.status === 'ready' &&
					view.trusted &&
					this.ownedClients.has(client),
			)
			if (owned) return this.project(owned.view.id).client
		}
		const { project } = await this.openOwnedPal(id)
		return this.project(project.id).client
	}
	private async controlledComputer(
		id: string,
		generation: string,
		expectedMode: 'pal' | 'operator',
		reuseReady = false,
	): Promise<RuntimeClient> {
		if (
			typeof generation !== 'string' ||
			!/^[1-9][0-9]{0,15}$/.test(generation) ||
			!Number.isSafeInteger(Number(generation))
		)
			throw new Error('Invalid Pal computer generation.')
		const client = await this.controlClient(id, reuseReady)
		if (!client.supportsPalComputerControl())
			throw new Error('This computer provider does not support operator control.')
		const current = await this.computerStatus(client, id)
		if (
			current.status !== 'ready' ||
			current.generation !== generation ||
			!current.control?.supported
		)
			throw new Error('This Pal computer changed. Refresh its status before changing control.')
		if (current.control.mode !== expectedMode)
			throw new Error('This Pal computer’s control changed. Refresh its status.')
		return client
	}
	async takeOverPalComputer(id: string, generation: string): Promise<PalComputerView> {
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		this.changingPals.add(id)
		this.advanceComputerAuthority(id)
		try {
			// Verify the exact current computer before cancelling any owned work.
			const client = await this.controlledComputer(id, generation, 'pal')
			const owned = [...this.conversations.values()].filter((item) => item.view.palId === id)
			for (const item of owned) {
				if (item.running) {
					const settled = item.runSettled
					if (!settled) throw new Error('This Pal turn has no confirmed completion boundary.')
					await this.cancel(item.view.id)
					await settled
				}
				if (item.running || item.permissions.size)
					throw new Error('This Pal’s active work did not stop. Retry after it finishes.')
				const jobs = (await this.jobs(item.view.id)) as JobView[]
				if (!Array.isArray(jobs))
					throw new Error('This Pal’s background work could not be verified.')
				for (const job of jobs)
					if (job.status === 'running') await this.stopJob(item.view.id, job.id)
				const remaining = (await this.jobs(item.view.id)) as JobView[]
				if (
					!Array.isArray(remaining) ||
					remaining.some((job) => job.status === 'running' || job.recoveryRequired)
				)
					throw new Error('This Pal’s background work did not stop. Retry after recovery.')
			}
			const state = (await client.request('namzu/pals/computer/take_over', {
				palId: id,
				generation,
			})) as PalComputerView
			if (
				state.status !== 'ready' ||
				state.generation !== generation ||
				state.control?.mode !== 'operator'
			)
				throw new Error('The Pal computer did not confirm operator control. Refresh its status.')
			this.operatorComputers.set(id, generation)
			return state
		} finally {
			this.advanceComputerAuthority(id)
			this.changingPals.delete(id)
		}
	}
	async returnPalComputerControl(id: string, generation: string): Promise<PalComputerView> {
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		this.changingPals.add(id)
		this.advanceComputerAuthority(id)
		try {
			const client = await this.controlledComputer(id, generation, 'operator')
			const state = (await client.request('namzu/pals/computer/return_control', {
				palId: id,
				generation,
			})) as PalComputerView
			if (
				state.status !== 'ready' ||
				state.generation !== generation ||
				state.control?.mode !== 'pal'
			)
				throw new Error('The Pal computer did not confirm returned control. Refresh its status.')
			this.operatorComputers.delete(id)
			// Queued work remains parked. Returning input authority does not start a turn.
			return state
		} finally {
			this.advanceComputerAuthority(id)
			this.changingPals.delete(id)
		}
	}
	async palComputerInput(id: string, generation: string, input: PalComputerInput): Promise<void> {
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s control change to finish.')
		const epoch = this.computerAuthorityEpochs.get(id) ?? 0
		const captured = structuredClone(input)
		const client = await this.controlledComputer(id, generation, 'operator', true)
		if (this.changingPals.has(id) || epoch !== (this.computerAuthorityEpochs.get(id) ?? 0))
			throw new Error(
				'This input belongs to an earlier computer control. Refresh before sending input.',
			)
		const result = (await client.request('namzu/pals/computer/input', {
			palId: id,
			generation,
			input: captured,
		})) as { type?: string }
		if (result?.type !== 'ok') throw new Error('The Pal computer did not confirm this input.')
	}
	/** Starts in flight, by Pal: repeated clicks join the one start instead of making another. */
	private readonly startingPalInboxes = new Map<string, Promise<PalInboxStartView>>()
	private palInboxClient(client: RuntimeClient): RuntimeClient {
		if (!client.supportsPalInboxStart())
			throw new Error('Update Namzu to start a Pal from its waiting messages.')
		return client
	}
	private readInboxStart(value: unknown, palId: string): PalInboxStartView {
		const view = value as Partial<PalInboxStartView> | null
		if (
			!view ||
			view.v !== 1 ||
			view.palId !== palId ||
			typeof view.waiting !== 'number' ||
			!Number.isSafeInteger(view.waiting) ||
			view.waiting < 0 ||
			!['empty', 'waiting', 'reading', 'failed'].includes(view.state as string)
		)
			throw new Error('Namzu returned an invalid Pal start state.')
		return {
			v: 1,
			palId,
			waiting: view.waiting,
			state: view.state as PalInboxStartView['state'],
			...(typeof view.message === 'string' ? { message: view.message.slice(0, 400) } : {}),
		}
	}
	/** What waits in one Pal's inbox. Reads only; it never starts anything. */
	async palInboxStart(palId: string): Promise<PalInboxStartView> {
		this.assertPalAvailable(palId)
		const client = this.palInboxClient(await this.controlClient(palId, true))
		this.assertPalAvailable(palId)
		return this.readInboxStart(await client.request('namzu/pals/inbox/status', { palId }), palId)
	}
	/**
	 * The person's click on "Start <Pal>". The consent is this call: main checks the Pal here
	 * (it exists, belongs to this registry, is not deleted or paused) and mints the evidence for
	 * the click itself, so nothing a conversation or the page says can stand in for it.
	 */
	async startPalInbox(palId: string): Promise<PalInboxStartView> {
		this.assertPalAvailable(palId)
		const running = this.startingPalInboxes.get(palId)
		if (running) return running
		const start = this.startOwnedPalInbox(palId).finally(() => {
			this.startingPalInboxes.delete(palId)
		})
		this.startingPalInboxes.set(palId, start)
		return start
	}
	private async startOwnedPalInbox(palId: string): Promise<PalInboxStartView> {
		if (this.changingPals.has(palId)) throw new Error('Wait for this Pal’s changes to finish.')
		const current = (await (
			await this.registry()
		).request('namzu/pals/get', {
			id: palId,
		})) as PalView | null
		this.assertPalAvailable(palId)
		if (!current || current.id !== palId) throw new Error('This Pal is unavailable.')
		this.palRecords.set(palId, current)
		if (current.paused) throw new Error(`${current.name} is paused. Resume it first.`)
		const { project } = await this.openOwnedPal(palId)
		this.assertPalAvailable(palId)
		const client = this.palInboxClient(this.project(project.id).client)
		const clickId = randomUUID()
		return this.readInboxStart(
			await client.request('namzu/pals/inbox/start', { palId, clickId }, 60_000),
			palId,
		)
	}
	async startPalComputer(id: string): Promise<PalComputerView> {
		this.assertPalAvailable(id)
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		if (this.startingPalComputers.has(id)) throw new Error('Wait for this Pal computer to start.')
		this.startingPalComputers.add(id)
		try {
			const epoch = this.computerAuthorityEpochs.get(id) ?? 0
			const { project } = await this.openOwnedPal(id)
			if (this.changingPals.has(id) || epoch !== (this.computerAuthorityEpochs.get(id) ?? 0))
				throw new Error('This Pal computer changed before it could start. Refresh its status.')
			return await this.startOwnedPalComputer(id, this.project(project.id).client)
		} finally {
			this.startingPalComputers.delete(id)
		}
	}
	private async startOwnedPalComputer(id: string, client: RuntimeClient): Promise<PalComputerView> {
		return (await client.request(
			'namzu/pals/computer/start',
			{
				palId: id,
			},
			120_000,
		)) as PalComputerView
	}
	private assertPalComputerForegroundIdle(id: string): void {
		if (
			[...this.conversations.values()].some(
				(item) =>
					item.view.palId === id &&
					(item.running || item.admitting || item.queue.length || item.permissions.size),
			)
		)
			throw new Error('Stop this Pal’s active work before stopping its computer.')
	}
	private async assertPalComputerIdle(id: string, restarting = false): Promise<void> {
		const owned = [...this.conversations.values()].filter((item) => item.view.palId === id)
		this.assertPalComputerForegroundIdle(id)
		for (const item of owned) {
			const jobs = (
				restarting
					? await item.client.request('namzu/jobs/list', {
							sessionId: item.runtimeSessionId,
						})
					: await this.jobs(item.view.id)
			) as JobView[]
			if (
				!Array.isArray(jobs) ||
				jobs.some((job) => job.status === 'running' || (restarting && job.recoveryRequired))
			)
				throw new Error('Stop this Pal’s background work before stopping its computer.')
		}
		// A review notification can arrive while background jobs are being read.
		this.assertPalComputerForegroundIdle(id)
	}
	private async stopOwnedPalComputer(id: string, client: RuntimeClient): Promise<PalComputerView> {
		const state = (await client.request('namzu/pals/computer/stop', {
			palId: id,
		})) as PalComputerView
		if (state.status === 'stopped' && !state.requiresStop) {
			this.operatorComputers.delete(id)
			for (const [viewerId, viewer] of this.computerViewers)
				if (viewer.palId === id) this.closePalComputerStream(viewerId)
		}
		return state
	}
	async stopPalComputer(id: string): Promise<PalComputerView> {
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		this.changingPals.add(id)
		this.advanceComputerAuthority(id)
		try {
			const { project } = await this.openOwnedPal(id)
			await this.assertPalComputerIdle(id)
			return await this.stopOwnedPalComputer(id, this.project(project.id).client)
		} finally {
			this.advanceComputerAuthority(id)
			this.changingPals.delete(id)
		}
	}
	async rebootPalComputer(id: string, generation: string): Promise<PalComputerView> {
		if (
			typeof generation !== 'string' ||
			!/^[1-9][0-9]{0,15}$/.test(generation) ||
			!Number.isSafeInteger(Number(generation))
		)
			throw new Error('Invalid Pal computer generation.')
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		this.changingPals.add(id)
		this.advanceComputerAuthority(id)
		try {
			const { pal, project } = await this.openOwnedPal(id)
			if (pal.paused) throw new Error('Resume this Pal before restarting its computer.')
			const client = this.project(project.id).client
			const assertGeneration = async () => {
				const state = await this.computerStatus(client, id)
				if (state.status !== 'ready' || state.generation !== generation)
					throw new Error('This Pal computer changed. Refresh its status before restarting.')
			}
			await assertGeneration()
			await this.assertPalComputerIdle(id, true)
			await assertGeneration()
			// Profile pause may have changed in another process during the idle check.
			const current = (await (await this.registry()).request('namzu/pals/get', { id })) as PalView
			if (current?.id !== id || current.workspace !== pal.workspace)
				throw new Error('This Pal changed before its computer could restart.')
			this.palRecords.set(id, current)
			if (current.paused) throw new Error('Resume this Pal before restarting its computer.')
			this.assertPalComputerForegroundIdle(id)
			if (this.project(project.id).client !== client || !this.ownedClients.has(client))
				throw new Error('This Pal’s connection changed before restarting its computer.')
			const stopped = await this.stopOwnedPalComputer(id, client)
			if (stopped.status !== 'stopped')
				throw new Error('The Pal computer did not confirm its stop. Recover it before restarting.')
			if (this.project(project.id).client !== client || !this.ownedClients.has(client))
				throw new Error('This Pal’s connection changed before its computer could start.')
			const started = await this.startOwnedPalComputer(id, client)
			if (this.project(project.id).client !== client || !this.ownedClients.has(client))
				throw new Error('This Pal’s connection changed while its computer was starting.')
			if (
				started.status !== 'ready' ||
				typeof started.generation !== 'string' ||
				!/^[1-9][0-9]{0,15}$/.test(started.generation) ||
				!Number.isSafeInteger(Number(started.generation)) ||
				started.generation === generation ||
				(started.control?.supported && started.control.mode !== 'pal')
			)
				throw new Error('The Pal computer did not confirm a new generation. Refresh its status.')
			return started
		} finally {
			this.advanceComputerAuthority(id)
			this.changingPals.delete(id)
		}
	}
	async palScreen(id: string, generation?: string): Promise<PalScreenView> {
		const client = await this.controlClient(id, true)
		const screen = (await client.request('namzu/pals/computer/screen', {
			palId: id,
			...(generation === undefined ? {} : { generation }),
		})) as PalScreenView
		if (
			!screen ||
			typeof screen.source !== 'string' ||
			screen.source.length > 7_000_000 ||
			!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(screen.source) ||
			!Number.isSafeInteger(screen.width) ||
			!Number.isSafeInteger(screen.height) ||
			screen.width < 1 ||
			screen.height < 1 ||
			screen.width > 4096 ||
			screen.height > 3072
		)
			throw new Error('The Pal computer returned an invalid screen.')
		return screen
	}
	async openPalComputerStream(id: string, generation: string): Promise<PalComputerStreamView> {
		if (!this.streamProxy) throw new Error('Update Namzu to enable live computer views.')
		if (!/^[1-9][0-9]{0,15}$/.test(generation) || !Number.isSafeInteger(Number(generation)))
			throw new Error('Invalid Pal computer generation.')
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		const epoch = this.computerAuthorityEpochs.get(id) ?? 0
		const client = await this.controlClient(id, true)
		const descriptor = await client.request('namzu/pals/computer/stream', {
			palId: id,
			generation,
		})
		if (
			this.closing ||
			this.changingPals.has(id) ||
			epoch !== (this.computerAuthorityEpochs.get(id) ?? 0) ||
			!this.ownedClients.has(client)
		)
			throw new Error('This Pal computer changed before the view opened.')
		const view = this.streamProxy.open(descriptor, generation)
		const onClosed = () => this.closePalComputerStream(view.id)
		this.computerViewers.set(view.id, { palId: id, client, onClosed })
		client.once('closed', onClosed)
		return view
	}
	closePalComputerStream(id: string): void {
		if (typeof id !== 'string') throw new Error('Invalid computer view.')
		const viewer = this.computerViewers.get(id)
		if (!viewer) return
		viewer.client.off('closed', viewer.onClosed)
		this.computerViewers.delete(id)
		this.streamProxy?.close(id)
	}
	private emit(event: DesktopEvent): void {
		if (
			event.kind !== 'connection' &&
			event.kind !== 'workspace' &&
			event.kind !== 'terminals' &&
			event.kind !== 'pal-deleted' &&
			event.kind !== 'project-removed' &&
			event.kind !== 'settings' &&
			event.kind !== 'open-settings' &&
			event.kind !== 'tab-command' &&
			event.kind !== 'model-catalogue-updated' &&
			event.kind !== 'providers-changed'
		) {
			const id = event.kind === 'permission' ? event.request.sessionId : event.sessionId
			const session = this.conversations.get(id)
			if (session) {
				const versioned = {
					...event,
					// This is the host's observation time. Provider events have no
					// source clock on the ACP wire; never imply they do.
					...(event.at === undefined ? { at: Date.now() } : {}),
					revision: session.projection.revision + 1,
				}
				session.projection = applyEvent(session.projection, versioned)
				if (
					versioned.kind === 'prompt' ||
					versioned.kind === 'permission' ||
					(versioned.kind === 'state' && !versioned.running) ||
					(versioned.kind === 'update' &&
						(versioned.update.kind === 'turn_ended' ||
							(session.hasPrompted &&
								!this.savedDesktop?.conversations.some(
									(item) => item.view.id === session.view.id && item.hasPrompted,
								))))
				)
					this.persistDesktop(true)
				const retirements: DesktopEvent[] = []
				if (versioned.kind === 'prompt') {
					for (const eviction of this.attachmentPreviews.admit(id, versioned.attachments ?? [])) {
						const retired = this.conversations.get(eviction.sessionId)
						if (!retired) continue
						const retirement = {
							kind: 'attachment-previews-evicted' as const,
							...eviction,
							revision: retired.projection.revision + 1,
						}
						retired.projection = applyEvent(retired.projection, retirement)
						retirements.push(retirement)
					}
				}
				// Commit all display retirements before a renderer transport can fail.
				// Healthy clients still receive the prompt before its ordered retirements.
				this.publish(versioned)
				for (const retirement of retirements) this.publish(retirement)
				return
			}
		}
		this.publish(event)
	}
	listProjects(): ProjectView[] {
		return [...this.projects.values()].map(({ view }) => ({ ...view }))
	}
	/**
	 * Folders the app is about to reopen from the last run, keyed by path. Until a folder's
	 * connection is registered the window is told it is `connecting`, so a launch never reads
	 * as "no projects" while the sequential restore has not reached them yet.
	 */
	private readonly expectedProjects = new Map<string, ProjectView>()
	/** Saved projects whose folder no longer exists: listed as such until located or removed. */
	private readonly missingProjects = new Map<string, ProjectView>()
	/** A located folder takes over the id of the missing project it replaces, keyed by its path. */
	private readonly relocations = new Map<string, string>()
	expectProjects(paths: readonly string[]): void {
		for (const path of paths) {
			const saved = this.savedDesktop?.projects.find((item) => item.path === path)
			if (!saved || this.expectedProjects.has(path)) continue
			const palId = this.savedDesktop?.conversations.find(
				(item) => item.view.projectId === saved.id && item.view.palId,
			)?.view.palId
			this.expectedProjects.set(path, {
				id: saved.id,
				path,
				name: basename(path),
				trusted: false,
				status: 'connecting',
				...(palId ? { palId } : {}),
			})
		}
	}
	/** The restore of this folder is over; a folder that never registered is reported as failed. */
	settleExpectedProject(path: string): void {
		const placeholder = this.expectedProjects.get(path)
		if (!placeholder) return
		this.expectedProjects.delete(path)
		if ([...this.projects.values()].some(({ view }) => view.path === path)) return
		if (!existsSync(path)) {
			const missing: ProjectView = {
				...placeholder,
				status: 'error',
				error: 'Folder not found',
				missing: true,
			}
			this.missingProjects.set(missing.id, missing)
			this.emit({ kind: 'connection', project: { ...missing } })
			return
		}
		this.emit({
			kind: 'connection',
			project: { ...placeholder, status: 'error', error: 'Namzu could not open this folder.' },
		})
	}
	missingProject(id: string): ProjectView | undefined {
		// A folder that vanished while its project was open is missing too, though it is still connected.
		const open = this.projects.get(id)?.view
		const view = this.missingProjects.get(id) ?? (open?.missing ? open : undefined)
		return view && { ...view }
	}
	missingProjectPaths(): string[] {
		return [...this.missingProjects.values()].map((item) => item.path)
	}
	expectRelocation(path: string, projectId: string): void {
		if (this.missingProjects.has(projectId)) this.relocations.set(path, projectId)
	}
	/** Forgets a project whose folder is gone: its saved row, conversations and drafts. Files are not touched. */
	async forgetMissingProject(projectId: string): Promise<ProjectRemovalResult> {
		const missing = this.missingProjects.get(projectId)
		if (!missing) throw new Error('This project is no longer in Namzu.')
		const sessionIds = new Set<string>()
		for (const item of this.savedDesktop?.conversations ?? [])
			if (item.view.projectId === projectId) sessionIds.add(item.view.id)
		const retiredOwners = new Set(sessionIds)
		const isProjectDraft = (ownerId: string) => {
			try {
				return projectDraftOwner(ownerId)?.projectId === projectId
			} catch {
				return false
			}
		}
		for (const ownerId of [...this.projectDrafts.keys()])
			if (isProjectDraft(ownerId)) {
				retiredOwners.add(ownerId)
				this.projectDrafts.delete(ownerId)
			}
		for (const [attachmentId, file] of this.attachmentFiles)
			if (retiredOwners.has(file.ownerId)) this.attachmentFiles.delete(attachmentId)
		for (const id of sessionIds) {
			this.conversations.delete(id)
			this.attachmentPreviews.forget(id)
		}
		this.missingProjects.delete(projectId)
		for (const [path, id] of this.relocations) if (id === projectId) this.relocations.delete(path)
		if (this.savedDesktop)
			this.savedDesktop = withoutProject(
				this.savedDesktop,
				projectId,
				isProjectDraft,
				retiredOwners,
			)
		this.persistDesktop(true)
		const retired = [...sessionIds]
		this.emit({ kind: 'project-removed', projectId, sessionIds: retired })
		// It never had a connection this session, so there is no trust entry to take back.
		return { projectId, sessionIds: retired, trust: { state: 'not-connected' } }
	}
	/** What a window reads: the connected projects, then the ones still to be reopened. */
	projectsForWindow(): ProjectView[] {
		const listed = this.listProjects()
		const known = new Set(listed.map((item) => item.path))
		const connected = new Set(listed.map((item) => item.id))
		return [
			...listed,
			...[...this.missingProjects.values()]
				.filter((item) => !connected.has(item.id))
				.map((item) => ({ ...item })),
			...[...this.expectedProjects.values()]
				.filter((item) => !known.has(item.path))
				.map((item) => ({ ...item })),
		]
	}
	/** Saved views of the given conversations (open tabs), for the pre-paint snapshot. */
	savedConversationViews(ids: readonly string[]): ConversationView[] {
		const wanted = new Set(ids)
		return (this.savedDesktop?.conversations ?? [])
			.filter((item) => wanted.has(item.view.id))
			.map((item) => ({ ...item.view }))
	}
	async openChat(): Promise<ProjectView> {
		if (this.closing) throw new Error('Namzu is closing.')
		if (!this.registryDirectory) throw new Error('The native chat workspace is unavailable.')
		if (this.chatStarting) return this.chatStarting
		const operation = (async () => {
			const path = await normalChatWorkspace(this.registryDirectory as string)
			const view = await this.openProject(path)
			if (view.palId) throw new Error('A Pal workspace cannot become a normal conversation.')
			if (view.status !== 'ready') return view
			return view.trusted ? view : this.trust(view.id)
		})()
		this.chatStarting = operation
		try {
			return await operation
		} finally {
			if (this.chatStarting === operation) this.chatStarting = undefined
		}
	}
	async openProject(path: string): Promise<ProjectView> {
		return this.openProjectDirectory(path)
	}
	private async openProjectDirectory(
		path: string,
		ownedPalWorkspace = false,
	): Promise<ProjectView> {
		if (this.closing) throw new Error('Namzu is closing.')
		const canonical = await realpath(path)
		let cwd = canonical
		if (ownedPalWorkspace) {
			// Windows' native realpath can change only directory spelling while the
			// SDK's saved control path remains exact. Keep that approved spelling
			// only after fresh directory identity and the SDK's alias guard agree.
			const expected = resolve(path)
			const original = await lstat(expected, { bigint: true })
			if (
				path !== expected ||
				!original.isDirectory() ||
				original.isSymbolicLink() ||
				realpathSync(expected) !== expected
			)
				throw new Error('This Pal’s workspace identity changed.')
			if (canonical !== expected) {
				if (process.platform !== 'win32' || canonical.toLowerCase() !== expected.toLowerCase())
					throw new Error('This Pal’s workspace identity changed.')
				const actual = await lstat(canonical, { bigint: true })
				if (
					!actual.isDirectory() ||
					actual.isSymbolicLink() ||
					original.ino <= 0n ||
					actual.dev !== original.dev ||
					actual.ino !== original.ino ||
					actual.birthtimeNs !== original.birthtimeNs
				)
					throw new Error('This Pal’s workspace identity changed.')
			}
			cwd = expected
		}
		if (!(await stat(cwd)).isDirectory()) throw new Error('Choose a folder.')
		if (this.closing) throw new Error('Namzu is closing.')
		const pending = this.projectStarting.get(cwd)
		if (pending) return pending
		const operation = this.connectProject(cwd, ownedPalWorkspace ? canonical : undefined)
		this.projectStarting.set(cwd, operation)
		try {
			return await operation
		} finally {
			if (this.projectStarting.get(cwd) === operation) this.projectStarting.delete(cwd)
		}
	}
	private async connectProject(cwd: string, ownedPalCanonical?: string): Promise<ProjectView> {
		const existing = [...this.projects.values()].find(
			({ view }) =>
				view.path === cwd ||
				(view.status === 'error' &&
					ownedPalCanonical !== undefined &&
					view.path === ownedPalCanonical),
		)
		if (existing?.view.status !== 'error') {
			if (existing) return existing.view
		}
		if (existing) {
			this.backgroundWork.invalidateProject(existing.view.id)
			await this.closeClient(existing.client)
			if (this.closing) throw new Error('Namzu is closing.')
			this.projects.delete(existing.view.id)
		}
		const isChat = await isNormalChatWorkspace(cwd, this.registryDirectory)
		const view: ProjectView = {
			id:
				existing?.view.id ??
				this.relocations.get(cwd) ??
				this.savedDesktop?.projects.find((item) => item.path === cwd)?.id ??
				randomUUID(),
			path: cwd,
			name: isChat ? 'Chat' : basename(cwd),
			...(isChat ? { isChat: true } : {}),
			trusted: false,
			status: 'connecting',
		}
		const client = new RuntimeClient(cwd, this.command, this.diagnostics)
		this.ownedClients.add(client)
		const project = { view, client }
		for (const saved of this.savedDesktop?.conversations ?? []) {
			if (saved.view.projectId !== view.id || this.conversations.has(saved.view.id)) continue
			this.conversations.set(saved.view.id, {
				view: { ...saved.view },
				runtimeSessionId: saved.runtimeSessionId,
				hasPrompted: saved.hasPrompted,
				client,
				running: false,
				queue: [],
				draft: saved.draft,
				projection: emptyThread(),
				permissions: new Map(),
				needsLoad: true,
				needsHistory: saved.hasPrompted,
				restorePending: true,
				...(saved.draftSettings ? { draftSettings: structuredClone(saved.draftSettings) } : {}),
				...(saved.providerSelection ? { providerSelection: { ...saved.providerSelection } } : {}),
			})
		}
		for (const session of this.conversations.values()) {
			if (session.view.projectId !== view.id) continue
			session.client = client
			session.needsLoad = true
		}
		this.projects.set(view.id, project)
		this.relocations.delete(cwd)
		this.missingProjects.delete(view.id)
		client.on('frame', (frame) => {
			if (!this.closing && this.projects.get(view.id) === project) this.onFrame(project, frame)
		})
		client.on('closed', (error: Error) => {
			if (this.closing || this.projects.get(view.id) !== project) return
			this.backgroundWork.invalidateProject(view.id)
			// A connection that was working and dropped is not an unopenable folder: the
			// conversation stays on screen and Namzu reconnects by itself.
			const lost = view.status === 'ready' && !view.missing
			const failure = view.status === 'error' && view.error ? view.error : error.message
			view.status = 'error'
			view.error = failure
			if (lost) view.lost = true
			for (const session of this.conversations.values()) {
				if (session.view.projectId !== view.id) continue
				session.running = false
				session.permissions.clear()
				if (lost) session.connectionLost = true
				this.state(session, failure)
				this.emit({ kind: 'permission-cleared', sessionId: session.view.id })
			}
			this.emit({ kind: 'connection', project: { ...view } })
			if (lost && this.options.autoReconnect) void this.reconnectAfterLoss(view.id)
		})
		try {
			await client.start()
			if (this.closing) throw new Error('Namzu is closing.')
			const status = (await client.request('namzu/project/status')) as {
				trusted: boolean
				pal?: PalView
			}
			if (this.closing) throw new Error('Namzu is closing.')
			view.trusted = status.trusted === true
			if (view.trusted && !status.pal) {
				// The host says trusted, but the folder's automatic settings may have changed since
				// this app trusted it: until the person confirms again it behaves as untrusted.
				const changed = await this.settingsChangedSinceTrust(cwd)
				if (this.closing) throw new Error('Namzu is closing.')
				if (changed.length > 0) {
					view.trusted = false
					view.settingsChanged = changed
				}
			}
			if (status.pal) {
				view.palId = status.pal.id
				view.name = status.pal.name
				this.palRecords.set(status.pal.id, status.pal)
			}
			view.status = 'ready'
		} catch (error) {
			view.status = 'error'
			view.error = error instanceof Error ? error.message : String(error)
			await this.closeClient(client)
			if (this.closing) throw error
		}
		this.emit({ kind: 'connection', project: { ...view } })
		if (view.status === 'ready') this.clearLostErrors(view.id)
		this.persistDesktop()
		return { ...view }
	}
	private project(id: unknown): Project {
		if (this.closing) throw new Error('Namzu is closing.')
		if (typeof id !== 'string') throw new Error('Invalid project.')
		if (this.removingProjects.has(id)) throw new Error('This project is being removed.')
		const project = this.projects.get(id)
		if (!project || project.view.status !== 'ready')
			throw new Error('Namzu is not connected to this project. Reconnect it, then try again.')
		// Every action on a project passes here: a folder that has gone is said to be gone, not "untrusted".
		if (!existsSync(project.view.path)) {
			this.markFolderMissing(project)
			throw new Error(project.view.error)
		}
		return project
	}
	/**
	 * The running host of a project that may hold terminals, for the terminal tabs. A terminal runs
	 * on the person's machine like the agent's own tools do, so the folder must be trusted first.
	 */
	async terminalHost(projectId: unknown): Promise<{
		project: { id: string; name: string; path: string }
		connection: RuntimeClient
	}> {
		if (typeof projectId === 'string') this.assertFolderPresent(projectId)
		const project = this.project(projectId)
		if (project.view.palId) throw new Error('A Pal’s workspace has no terminal here.')
		if (!project.view.trusted) throw new Error('Trust this project to open a terminal in it.')
		// The shell, and the `namzu` typed into it, would read folder settings that changed since the last look.
		await this.assertSettingsUnchanged(project)
		return {
			project: { id: project.view.id, name: project.view.name, path: project.view.path },
			connection: project.client,
		}
	}
	private session(id: unknown): Conversation {
		if (typeof id !== 'string') throw new Error('Invalid conversation.')
		this.assertConversationAvailable(id)
		const session = this.conversations.get(id)
		if (!session) throw new Error('Open this conversation first.')
		this.project(session.view.projectId)
		return session
	}
	private assertConversationAvailable(id: string): void {
		if (this.removedConversations.has(id))
			throw new Error('This conversation is no longer available.')
		if (this.archivingConversations.has(id) || this.pendingConversationRemovals.has(id))
			throw new Error('Wait for this conversation’s removal to finish.')
	}
	async trust(id: string): Promise<ProjectView> {
		const project = this.project(id)
		await project.client.request('namzu/project/trust', {
			cwd: project.view.path,
			confirmed: true,
		})
		project.view.trusted = true
		project.view.settingsChanged = undefined
		await this.recordTrustedSettings(project.view.path)
		return { ...project.view }
	}
	/** Fail open on a read error: the host's own trust still applies, and the error is recorded. */
	private async settingsChangedSinceTrust(path: string): Promise<string[]> {
		if (!this.folderGuard) return []
		try {
			return await this.folderGuard.check(path)
		} catch (error) {
			this.diagnostics?.record('ipc_failed', { operation: 'folderFingerprint', error })
			return []
		}
	}
	/**
	 * The CLI reads a folder's hooks, plugins and commands when a session is created, long after
	 * connect: look again right before work that makes it read them. A folder that changed is
	 * untrusted until the person answers, and the work is refused.
	 */
	private async assertSettingsUnchanged(project: Project): Promise<void> {
		if (!this.folderGuard || project.view.palId || !project.view.trusted) return
		const changed = await this.settingsChangedSinceTrust(project.view.path)
		if (changed.length === 0) return
		project.view.trusted = false
		project.view.settingsChanged = changed
		this.emit({ kind: 'connection', project: { ...project.view } })
		throw new Error('This folder’s automatic settings changed. Review and trust it again.')
	}
	/** The re-prompt setting went from off to on: what changed while it was off is not news. */
	async rebaselineTrusted(): Promise<void> {
		for (const project of [...this.projects.values()]) {
			if (project.view.status !== 'ready' || !project.view.trusted || project.view.palId) continue
			await this.recordTrustedSettings(project.view.path)
		}
	}
	private async recordTrustedSettings(path: string): Promise<void> {
		try {
			await this.folderGuard?.record(path)
		} catch (error) {
			this.diagnostics?.record('ipc_failed', { operation: 'folderFingerprint', error })
		}
	}
	async listConversations(id: string): Promise<ConversationView[]> {
		const known = this.projects.get(id)
		if (known?.view.status === 'error')
			return [...this.conversations.values()]
				.filter((session) => session.view.projectId === id)
				.map((session) => ({ ...session.view }))
		const project = this.project(id)
		if (!project.view.trusted) return []
		const assertCurrent = this.metadataRead(project)
		const rows = (await project.client.request(
			project.view.palId ? 'namzu/pals/conversations/list' : 'namzu/conversations/list',
			project.view.palId ? { palId: project.view.palId } : {},
		)) as {
			id: string
			title: string
			updatedAt: string
			harness?: ConversationView['harness']
			palGreeting?: ConversationView['palGreeting']
		}[]
		assertCurrent()
		if (!Array.isArray(rows)) throw new Error('Namzu returned an invalid conversation list.')
		const views = rows
			.filter((row) => !this.removedConversations.has(row.id))
			.map((row) => ({
				id: this.runtimeSession(project, row.id)?.view.id ?? row.id,
				title: row.title,
				updatedAt: row.updatedAt,
				projectId: id,
				...(this.runtimeSession(project, row.id)?.view.pinned ||
				(!this.runtimeSession(project, row.id) &&
					(project.conversationCatalogue?.get(row.id)?.pinned ||
						this.savedDesktop?.conversations.find((item) => item.view.id === row.id)?.view.pinned))
					? { pinned: true as const }
					: {}),
				...(row.harness
					? { harness: row.harness }
					: this.runtimeSession(project, row.id)?.view.harness
						? { harness: this.runtimeSession(project, row.id)?.view.harness }
						: {}),
				...(project.view.palId ? { palId: project.view.palId } : {}),
				...(project.view.palId && row.palGreeting ? { palGreeting: row.palGreeting } : {}),
				...((
					this.runtimeSession(project, row.id)?.view ??
					this.savedDesktop?.conversations.find((item) => item.view.id === row.id)?.view
				)?.closedWhileRunning
					? { closedWhileRunning: true as const }
					: {}),
			}))
		const returned = new Set(views.map((row) => row.id))
		for (const session of this.conversations.values()) {
			if (session.view.projectId !== id || returned.has(session.view.id)) continue
			if (
				!session.needsLoad ||
				session.restorePending ||
				session.running ||
				session.queue.length ||
				session.draft.length ||
				this.attachments(session.view.id).length ||
				session.draftSettings?.choice ||
				session.draftSettings?.options?.effort !== undefined ||
				session.draftSettings?.options?.permissionMode !== undefined
			)
				views.unshift({ ...session.view })
		}
		project.conversationCatalogue = new Map(views.map((view) => [view.id, { ...view }]))
		return views
	}
	async removeConversation(
		sessionId: string,
	): Promise<{ sessionId: string; removed: true; archived: boolean }> {
		if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 400)
			throw new Error('Invalid conversation.')
		if (this.archivingConversations.has(sessionId))
			throw new Error('Wait for this conversation’s removal to finish.')
		if (this.removedConversations.has(sessionId))
			return {
				sessionId,
				removed: true,
				archived: this.removedConversations.get(sessionId) as boolean,
			}
		const session = this.conversations.get(sessionId)
		const view =
			session?.view ??
			[...this.projects.values()]
				.flatMap((project) => [...(project.conversationCatalogue?.values() ?? [])])
				.find((item) => item.id === sessionId) ??
			this.savedDesktop?.conversations.find((item) => item.view.id === sessionId)?.view
		if (!view) throw new Error('This conversation is no longer in the connected catalogue.')
		const runtimeId = session?.runtimeSessionId
		const unsent = Boolean(
			session &&
				!session.hasPrompted &&
				!session.needsHistory &&
				!session.projection.messages.some((message) => message.role === 'user') &&
				!session.projection.timeline.some((entry) => entry.kind !== 'message'),
		)
		// Only a row that was never live this run (unsent, catalogue-only, or restored from the
		// saved list and not yet loaded) may be dropped on the host's word that no journal exists.
		const deadRow = unsent || !session || Boolean(session.restorePending)
		const aliases = [...new Set([sessionId, ...(runtimeId ? [runtimeId] : [])])]
		const project = this.project(view.projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		if (view.palId) {
			this.assertPalAvailable(view.palId)
			if (this.changingPals.has(view.palId))
				throw new Error('Wait for this Pal’s changes to finish.')
		}
		const assertIdle = () => {
			if (this.projects.get(view.projectId) !== project || project.view.status !== 'ready')
				throw new Error('This conversation’s connection changed. Reopen it before removing.')
			if (
				session &&
				(this.conversations.get(sessionId) !== session ||
					session.runtimeSessionId !== runtimeId ||
					session.client !== project.client)
			)
				throw new Error('This conversation changed while removing it.')
			if (
				session &&
				(session.running ||
					session.admitting ||
					session.queue.length ||
					session.permissions.size ||
					session.reattaching ||
					session.selectionPending ||
					this.changingPlugins.has(sessionId))
			)
				throw new Error('Stop this conversation’s active work before removing it.')
			if (view.palId && this.changingPals.has(view.palId))
				throw new Error('Wait for this Pal’s changes to finish.')
		}
		assertIdle()
		this.archivingConversations.add(sessionId)
		try {
			let archived = false
			for (const alias of aliases) {
				// A proven never-prompted local owner can have no log at all. The
				// archive endpoint validates absence/ownership and existing jobs without
				// creating a provider context. Ordinary durable rows still preflight jobs.
				if (!unsent) {
					// A row whose journal this home or identity can no longer open is refused
					// by the jobs route with the ownership error. The archive endpoint below
					// re-derives ownership and idleness itself, so it adjudicates those rows.
					let jobs: JobView[] | null
					try {
						jobs = (await project.client.request('namzu/jobs/list', {
							sessionId: alias,
						})) as JobView[]
					} catch (error) {
						if (!(error instanceof Error) || !/does not belong to this project/.test(error.message))
							throw error
						jobs = null
					}
					if (
						jobs !== null &&
						(!Array.isArray(jobs) ||
							jobs.some(
								(job) =>
									!job ||
									typeof job.status !== 'string' ||
									job.status === 'running' ||
									job.recoveryRequired,
							))
					)
						throw new Error('Stop this conversation’s background work before removing it.')
				}
				assertIdle()
				this.pendingConversationRemovals.add(sessionId)
				let result: {
					sessionId?: unknown
					archived?: unknown
					missing?: unknown
				}
				try {
					result = (await project.client.request('namzu/conversations/archive', {
						sessionId: alias,
					})) as typeof result
				} catch (error) {
					// Saved under another identity: the journal is untouched, the row is dead.
					if (
						!(error instanceof Error) ||
						!/saved by a different Namzu identity/.test(error.message)
					)
						throw error
					result = { sessionId: alias, archived: false, missing: true }
				}
				// An absent journal is an observation the host reports for a row with no
				// durable conversation left; the row is dropped, nothing is archived.
				if (
					!result ||
					result.sessionId !== alias ||
					(result.archived !== true &&
						!(deadRow && result.archived === false && result.missing === true))
				)
					throw new Error('Conversation removal was not confirmed. Retry removing it.')
				archived ||= result.archived === true
				assertIdle()
			}
			this.removedConversations.set(sessionId, archived)
			this.pendingConversationRemovals.delete(sessionId)
			this.backgroundWork.invalidate(sessionId)
			this.conversations.delete(sessionId)
			this.attachmentPreviews.forget(sessionId)
			for (const [attachmentId, file] of this.attachmentFiles)
				if (file.ownerId === sessionId) this.attachmentFiles.delete(attachmentId)
			project.conversationCatalogue?.delete(sessionId)
			if (this.savedDesktop)
				this.savedDesktop = {
					...this.savedDesktop,
					conversations: this.savedDesktop.conversations.filter(
						(item) => item.view.id !== sessionId,
					),
				}
			this.persistDesktop(true)
			this.emit({
				kind: 'conversation-removed',
				sessionId,
				projectId: view.projectId,
				archived,
			})
			return { sessionId, removed: true, archived }
		} finally {
			this.archivingConversations.delete(sessionId)
		}
	}
	/**
	 * Takes a project out of Namzu. Its host connection is closed, its row, tabs, drafts and
	 * pins are forgotten, and its folder leaves the trust list. Nothing on disk is deleted:
	 * the folder and the conversation journals stay, so opening the folder again lists its
	 * conversations. Refused while any work in the project is still running.
	 */
	async removeProject(projectId: unknown): Promise<ProjectRemovalResult> {
		if (this.closing) throw new Error('Namzu is closing.')
		if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 400)
			throw new Error('Invalid project.')
		if (this.removingProjects.has(projectId))
			throw new Error('This project is already being removed.')
		const project = this.projects.get(projectId)
		if (!project && this.missingProjects.has(projectId)) return this.forgetMissingProject(projectId)
		if (!project) throw new Error('This project is no longer in Namzu.')
		const { view } = project
		if (view.palId) throw new Error('A Pal’s workspace is removed by deleting the Pal.')
		if (view.isChat) throw new Error('The chat workspace cannot be removed.')
		// A connection still starting would report itself back into the list after it was removed.
		if (view.status === 'connecting')
			throw new Error(`${view.name} is still connecting. Wait a moment, then remove the project.`)
		const ofProject = () =>
			[...this.conversations.values()].filter((item) => item.view.projectId === projectId)
		const assertIdle = () => {
			if (this.projects.get(projectId) !== project)
				throw new Error('This project changed while removing it. Try again.')
			const busy = projectBusyReason(view.name, ofProject(), this.changingPlugins)
			if (busy) throw new Error(busy)
			for (const item of ofProject())
				if (
					this.archivingConversations.has(item.view.id) ||
					this.pendingConversationRemovals.has(item.view.id)
				)
					throw new Error(`${view.name} is still changing. Wait a moment, then remove the project.`)
			const background = this.backgroundWork.snapshot()
			for (const item of ofProject()) {
				const status = background[item.view.id]
				if (status?.state === 'known' && status.runningCount > 0)
					throw new Error(
						`Background work is still running in ${view.name}. Stop it, then remove the project.`,
					)
			}
		}
		assertIdle()
		this.removingProjects.add(projectId)
		try {
			if (view.status === 'ready' && view.trusted) {
				// Jobs live in the host this removal closes, so a running one is a reason to wait.
				const loaded = ofProject().filter(
					(item) => item.hasPrompted && !item.needsHistory && item.client === project.client,
				)
				for (const item of loaded.slice(0, 50)) {
					let jobs: unknown
					try {
						jobs = await project.client.request(
							'namzu/jobs/list',
							{ sessionId: item.runtimeSessionId },
							8_000,
						)
					} catch {
						// An unreadable job list is unknown, not a reason; the same policy as updates.
						continue
					}
					if (
						Array.isArray(jobs) &&
						jobs.some((job) => job?.status === 'running' || job?.recoveryRequired)
					)
						throw new Error(
							`Background work is still running in ${view.name}. Stop it, then remove the project.`,
						)
				}
				assertIdle()
			}
			let trust: ProjectUntrust
			if (view.status !== 'ready') trust = { state: 'not-connected' }
			else if (!project.client.supportsProjectUntrust()) trust = { state: 'unsupported' }
			else {
				try {
					trust = parseUntrust(
						await project.client.request('namzu/project/untrust', {
							cwd: view.path,
							confirmed: true,
						}),
					)
				} catch (error) {
					this.diagnostics?.record('ipc_failed', { operation: 'removeProject', error })
					throw new Error(
						'Namzu could not take this folder off its trust list, so nothing was removed. Try again.',
					)
				}
				assertIdle()
			}
			// Leave the map first so the connection's own close is not reported as a failure.
			this.projects.delete(projectId)
			this.backgroundWork.invalidateProject(projectId)
			try {
				await this.closeClient(project.client)
			} catch (error) {
				this.diagnostics?.record('ipc_failed', { operation: 'removeProject', error })
			}
			const sessionIds = new Set<string>()
			for (const item of this.conversations.values())
				if (item.view.projectId === projectId) sessionIds.add(item.view.id)
			for (const id of project.conversationCatalogue?.keys() ?? []) sessionIds.add(id)
			for (const item of this.savedDesktop?.conversations ?? [])
				if (item.view.projectId === projectId) sessionIds.add(item.view.id)
			const retiredOwners = new Set(sessionIds)
			for (const id of sessionIds) {
				this.conversations.delete(id)
				this.attachmentPreviews.forget(id)
				this.backgroundWork.invalidate(id)
			}
			const isProjectDraft = (ownerId: string) => {
				try {
					return projectDraftOwner(ownerId)?.projectId === projectId
				} catch {
					return false
				}
			}
			for (const ownerId of [...this.projectDrafts.keys()])
				if (isProjectDraft(ownerId)) {
					retiredOwners.add(ownerId)
					this.projectDrafts.delete(ownerId)
				}
			for (const [attachmentId, file] of this.attachmentFiles)
				if (retiredOwners.has(file.ownerId)) this.attachmentFiles.delete(attachmentId)
			for (const [id, owner] of this.archivedOwners)
				if (owner === projectId) this.archivedOwners.delete(id)
			this.projectFiles.invalidate(view.path)
			if (this.savedDesktop)
				this.savedDesktop = withoutProject(
					this.savedDesktop,
					projectId,
					isProjectDraft,
					retiredOwners,
				)
			this.persistDesktop(true)
			const retired = [...sessionIds]
			this.emit({ kind: 'project-removed', projectId, sessionIds: retired })
			return { projectId, sessionIds: retired, trust }
		} finally {
			this.removingProjects.delete(projectId)
		}
	}
	/** Re-publishes one conversation's identity after a title, pin or fork change. */
	private commitConversationView(session: Conversation, project: Project): ConversationView {
		const view = { ...session.view }
		const catalogued = project.conversationCatalogue?.get(view.id)
		if (catalogued) {
			const { pinned: _pinned, ...rest } = catalogued
			project.conversationCatalogue?.set(view.id, {
				...rest,
				title: view.title,
				...(view.pinned ? { pinned: true as const } : {}),
			})
		}
		this.persistDesktop()
		this.emit({ kind: 'conversation-updated', sessionId: view.id, view })
		return { ...view }
	}
	/**
	 * A sidebar row is catalogue-only until it is opened. Acting on it adopts it with the
	 * record shape a fork gets (history read lazily), so the change lands in the saved store.
	 */
	private adoptCatalogued(sessionId: string): void {
		if (this.conversations.has(sessionId)) return
		this.assertConversationAvailable(sessionId)
		const catalogued = [...this.projects.values()]
			.flatMap((item) => [...(item.conversationCatalogue?.values() ?? [])])
			.find((item) => item.id === sessionId)
		if (!catalogued) return
		const project = this.project(catalogued.projectId)
		this.conversations.set(sessionId, {
			view: { ...catalogued },
			runtimeSessionId: sessionId,
			hasPrompted: true,
			needsLoad: true,
			needsHistory: true,
			client: project.client,
			running: false,
			queue: [],
			draft: '',
			projection: emptyThread(),
			permissions: new Map(),
		})
	}
	/** Rename, fork and Markdown export exist for Namzu-engine ordinary conversations only. */
	private namzuConversation(sessionId: unknown, action: string): Conversation {
		if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 400)
			throw new Error('Invalid conversation.')
		this.adoptCatalogued(sessionId)
		const session = this.session(sessionId)
		if (session.view.palId) throw new Error(`A Pal conversation cannot ${action}.`)
		if (session.view.harness && session.view.harness !== 'namzu')
			throw new Error(`This engine’s conversation cannot ${action} from Namzu.`)
		return session
	}
	private archivedClient(project: Project): RuntimeClient {
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		if (!project.client.supportsArchivedConversations())
			throw new Error('Update Namzu to a version that lists archived conversations.')
		return project.client
	}
	private conversationActionsClient(project: Project): RuntimeClient {
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		if (!project.client.supportsConversationActions())
			throw new Error('Update Namzu to a version that supports this conversation action.')
		return project.client
	}
	async renameConversation(sessionId: string, title: string): Promise<ConversationView> {
		if (typeof title !== 'string') throw new Error('Invalid conversation title.')
		const session = this.namzuConversation(sessionId, 'be renamed')
		const cleaned = withoutControls(title).trim()
		if (cleaned.length > 200) throw new Error('Use a title of at most 200 characters.')
		const project = this.project(session.view.projectId)
		const client = this.conversationActionsClient(project)
		const runtimeId = session.runtimeSessionId
		const result = (await client.request('namzu/conversations/rename', {
			sessionId: runtimeId,
			title: cleaned,
		})) as { title?: unknown }
		if (typeof result?.title !== 'string' || result.title.length > 4000)
			throw new Error('Namzu returned an invalid conversation title.')
		this.assertConversationAvailable(sessionId)
		if (this.conversations.get(sessionId) !== session)
			throw new Error('This conversation changed while renaming it.')
		session.view.title = result.title
		return this.commitConversationView(session, project)
	}
	async setConversationPinned(sessionId: string, pinned: boolean): Promise<ConversationView> {
		if (typeof pinned !== 'boolean') throw new Error('Invalid pin state.')
		if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 400)
			throw new Error('Invalid conversation.')
		this.adoptCatalogued(sessionId)
		const session = this.session(sessionId)
		if (session.view.palId) throw new Error('A Pal conversation cannot be pinned.')
		const project = this.project(session.view.projectId)
		if (pinned) session.view.pinned = true
		else session.view = withoutPin(session.view)
		return this.commitConversationView(session, project)
	}
	async forkConversation(sessionId: string): Promise<ConversationView> {
		const session = this.namzuConversation(sessionId, 'be forked')
		if (!session.hasPrompted && !session.needsHistory)
			throw new Error('Send a message before forking this conversation.')
		if (
			session.running ||
			session.admitting ||
			session.queue.length ||
			session.permissions.size ||
			session.reattaching ||
			session.selectionPending
		)
			throw new Error('Stop this conversation’s active work before forking it.')
		const project = this.project(session.view.projectId)
		const client = this.conversationActionsClient(project)
		const runtimeId = session.runtimeSessionId
		const result = (await client.request('namzu/conversations/fork', {
			sessionId: runtimeId,
		})) as { id?: unknown; title?: unknown }
		if (
			typeof result?.id !== 'string' ||
			!result.id.trim() ||
			result.id.length > 400 ||
			result.id.startsWith('project:') ||
			typeof result.title !== 'string' ||
			result.title.length > 4000
		)
			throw new Error('Namzu returned an invalid forked conversation.')
		if (this.closing) throw new Error('Namzu is closing.')
		if (this.projects.get(session.view.projectId) !== project || project.client !== client)
			throw new Error('This conversation’s connection changed while forking it.')
		if (this.conversations.has(result.id) || this.removedConversations.has(result.id))
			throw new Error('Namzu returned a conversation that already exists.')
		const view: ConversationView = {
			id: result.id,
			title: result.title,
			projectId: session.view.projectId,
			updatedAt: new Date().toISOString(),
			...(session.view.harness ? { harness: session.view.harness } : {}),
		}
		this.conversations.set(view.id, {
			view,
			runtimeSessionId: view.id,
			hasPrompted: true,
			// The copy's history is read from its own journal when it is first opened.
			needsLoad: true,
			needsHistory: true,
			client,
			running: false,
			queue: [],
			draft: '',
			projection: emptyThread(),
			permissions: new Map(),
			...(session.draftSettings ? { draftSettings: structuredClone(session.draftSettings) } : {}),
			...(session.providerSelection ? { providerSelection: { ...session.providerSelection } } : {}),
		})
		project.conversationCatalogue?.set(view.id, { ...view })
		this.persistDesktop()
		return { ...view }
	}
	async conversationMarkdown(sessionId: string): Promise<{ markdown: string; truncated: boolean }> {
		const session = this.namzuConversation(sessionId, 'be exported')
		const project = this.project(session.view.projectId)
		const client = this.conversationActionsClient(project)
		const result = (await client.request('namzu/conversations/markdown', {
			sessionId: session.runtimeSessionId,
		})) as { markdown?: unknown; truncated?: unknown }
		if (
			typeof result?.markdown !== 'string' ||
			typeof result.truncated !== 'boolean' ||
			result.markdown.length > 8 * 1024 * 1024
		)
			throw new Error('Namzu returned an invalid conversation export.')
		this.assertConversationAvailable(sessionId)
		return { markdown: result.markdown, truncated: result.truncated }
	}
	async projectGit(projectId: string): Promise<ProjectGitView | null> {
		const project = this.project(projectId)
		if (!project.view.trusted || project.view.palId || !project.client.supportsProjectGit())
			return null
		const client = project.client
		let result: unknown
		try {
			result = await client.request('namzu/project/git', {})
		} catch {
			// The row is informational; a failed read must not break the popover.
			return null
		}
		if (this.projects.get(projectId) !== project || project.client !== client) return null
		if (!result || typeof result !== 'object') return null
		const { branch, subject } = result as {
			branch?: unknown
			subject?: unknown
		}
		const text = (value: unknown, maximum: number): string | null | undefined =>
			value === null
				? null
				: typeof value === 'string'
					? withoutControls(value).slice(0, maximum) || null
					: undefined
		const checkedBranch = text(branch, 255)
		const checkedSubject = text(subject, 500)
		if (checkedBranch === undefined || checkedSubject === undefined) return null
		return { branch: checkedBranch, subject: checkedSubject }
	}
	/** Working-tree changes from the host's git reader; null when there is nothing to review. */
	async projectChanges(projectId: string): Promise<ProjectChangesView | null> {
		const project = this.project(projectId)
		if (
			!project.view.trusted ||
			project.view.isChat ||
			project.view.palId ||
			!project.client.supportsProjectChanges()
		)
			return null
		const client = project.client
		const result = await client.request('namzu/project/changes', {})
		if (this.projects.get(projectId) !== project || project.client !== client) return null
		if (result === null) return null
		const view = checkedProjectChanges(result)
		if (!view) throw new Error('Namzu returned invalid changes.')
		return view
	}
	async projectDiff(projectId: string, path: string): Promise<ProjectDiffView> {
		if (typeof path !== 'string' || path.length === 0 || path.length > 1_024)
			throw new Error('That path is not inside this project.')
		const project = this.project(projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		if (project.view.isChat || project.view.palId)
			throw new Error('Changes are only available in a project folder.')
		if (!project.client.supportsProjectChanges())
			throw new Error('Update Namzu to a version that can show changes.')
		const client = project.client
		const result = (await client.request('namzu/project/diff', {
			path,
		})) as Record<string, unknown>
		if (this.projects.get(projectId) !== project || project.client !== client)
			throw new Error('This project changed while reading the file.')
		const side = (value: unknown) =>
			value === null || (typeof value === 'string' && value.length <= 8 * 1024 * 1024)
		if (
			!result ||
			typeof result !== 'object' ||
			!side(result.before) ||
			!side(result.after) ||
			typeof result.binary !== 'boolean' ||
			typeof result.truncated !== 'boolean'
		)
			throw new Error('Namzu returned an invalid file comparison.')
		return {
			before: result.before as string | null,
			after: result.after as string | null,
			binary: result.binary,
			truncated: result.truncated,
		}
	}
	/**
	 * The folder every file call is confined to. It comes from the operator's own record of a
	 * trusted, ordinary project, never from the renderer. It does not need the project's Namzu
	 * connection: these calls read the folder directly, so they work while it reconnects.
	 */
	private async projectRoots(projectId: unknown): Promise<string[]> {
		const project = this.project(projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		if (project.view.isChat || project.view.palId)
			throw new Error('Files are only available in a project folder.')
		let real: string
		try {
			real = await realpath(project.view.path)
		} catch {
			throw new Error('This project folder is not available.')
		}
		return [real, ...(project.view.path === real ? [] : [project.view.path])]
	}
	async listProjectDirectory(projectId: string, dir: string): Promise<ProjectFileEntry[]> {
		return this.projectFiles.list((await this.projectRoots(projectId))[0] as string, dir)
	}
	async projectFileIndex(projectId: string): Promise<{ paths: string[]; truncated: boolean }> {
		return this.projectFiles.index((await this.projectRoots(projectId))[0] as string)
	}
	async readProjectFile(projectId: string, path: string): Promise<ProjectFileContent> {
		return this.projectFiles.read((await this.projectRoots(projectId))[0] as string, path)
	}
	async resolveProjectLinks(projectId: string, refs: string[]): Promise<ProjectLinkResolution[]> {
		return resolveProjectLinks(await this.projectRoots(projectId), refs)
	}
	async openProjectPath(
		projectId: string,
		path: string,
		target: OpenTarget,
		line?: number,
	): Promise<void> {
		if (!this.openIn) throw new Error('Opening files is not available here.')
		if (target !== 'editor' && target !== 'file-manager' && target !== 'terminal')
			throw new Error('That way of opening is not supported.')
		const confined = await confineProjectPath(
			(await this.projectRoots(projectId))[0] as string,
			path,
		)
		const kind = (await stat(confined.absolute)).isDirectory() ? 'directory' : 'file'
		await this.openIn.open(confined.absolute, kind, target, line)
	}
	async projectEditors(): Promise<{ id: 'vscode' | 'cursor'; label: string }[]> {
		return ((await this.openIn?.editors()) ?? []).map(({ id, label }) => ({
			id,
			label,
		}))
	}
	async archivedConversations(projectId: string): Promise<ConversationView[]> {
		const project = this.project(projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		if (project.view.palId) return []
		const client = this.archivedClient(project)
		const rows = (await client.request('namzu/conversations/archived', {})) as unknown
		if (!Array.isArray(rows)) throw new Error('Namzu returned an invalid archived list.')
		if (this.projects.get(projectId) !== project || project.client !== client)
			throw new Error('This project’s connection changed while reading archived conversations.')
		const views: ConversationView[] = []
		for (const row of rows as {
			id?: unknown
			title?: unknown
			updatedAt?: unknown
		}[]) {
			if (
				typeof row?.id !== 'string' ||
				!row.id.trim() ||
				row.id.length > 400 ||
				typeof row.title !== 'string' ||
				row.title.length > 4000 ||
				typeof row.updatedAt !== 'string'
			)
				throw new Error('Namzu returned an invalid archived list.')
			views.push({
				id: row.id,
				title: row.title,
				updatedAt: row.updatedAt,
				projectId,
			})
			this.archivedOwners.set(row.id, projectId)
		}
		return views
	}
	async restoreConversation(sessionId: string): Promise<ConversationView> {
		if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 400)
			throw new Error('Invalid conversation.')
		const projectId = this.archivedOwners.get(sessionId)
		if (!projectId) throw new Error('Open the archived list first.')
		const project = this.project(projectId)
		const client = this.archivedClient(project)
		const row = (await client.request('namzu/conversations/unarchive', {
			sessionId,
		})) as {
			id?: unknown
			title?: unknown
			updatedAt?: unknown
		}
		if (
			row?.id !== sessionId ||
			typeof row.title !== 'string' ||
			row.title.length > 4000 ||
			typeof row.updatedAt !== 'string'
		)
			throw new Error('Namzu returned an invalid restored conversation.')
		if (this.closing) throw new Error('Namzu is closing.')
		if (this.projects.get(projectId) !== project || project.client !== client)
			throw new Error('This project’s connection changed while restoring the conversation.')
		this.archivedOwners.delete(sessionId)
		this.removedConversations.delete(sessionId)
		const view: ConversationView = {
			id: sessionId,
			title: row.title,
			projectId,
			updatedAt: row.updatedAt,
		}
		if (!this.conversations.has(sessionId))
			this.conversations.set(sessionId, {
				view,
				runtimeSessionId: sessionId,
				hasPrompted: true,
				// History is read from the journal when the conversation is first opened.
				needsLoad: true,
				needsHistory: true,
				client,
				running: false,
				queue: [],
				draft: '',
				projection: emptyThread(),
				permissions: new Map(),
			})
		project.conversationCatalogue?.set(sessionId, { ...view })
		this.persistDesktop()
		this.emit({ kind: 'conversation-updated', sessionId, view })
		return { ...view }
	}
	async newConversation(projectId: string): Promise<ConversationView> {
		const project = this.project(projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		await this.assertSettingsUnchanged(project)
		this.assertPalAdmission(project.view.palId)
		const palId = project.view.palId
		if (palId)
			this.startingPalConversations.set(palId, (this.startingPalConversations.get(palId) ?? 0) + 1)
		try {
			const result = (await project.client.request('session/new', {
				cwd: project.view.path,
			})) as {
				sessionId: string
			}
			this.assertPalAdmission(palId)
			const claim = project.view.palId
				? ((await project.client.request('namzu/pals/conversations/claim', {
						palId: project.view.palId,
						sessionId: result.sessionId,
					})) as { palGreeting?: ConversationView['palGreeting'] })
				: undefined
			this.assertPalAdmission(palId)
			const view: ConversationView = {
				id: result.sessionId,
				title: 'New conversation',
				projectId,
				updatedAt: new Date().toISOString(),
				...(project.view.palId ? { palId: project.view.palId } : {}),
				...(claim?.palGreeting ? { palGreeting: claim.palGreeting } : {}),
			}
			this.conversations.set(view.id, {
				view,
				runtimeSessionId: view.id,
				hasPrompted: Boolean(project.view.palId),
				client: project.client,
				running: false,
				queue: [],
				draft: '',
				projection: emptyThread(),
				permissions: new Map(),
			})
			this.persistDesktop()
			return view
		} finally {
			if (palId) {
				const remaining = (this.startingPalConversations.get(palId) ?? 1) - 1
				if (remaining) this.startingPalConversations.set(palId, remaining)
				else this.startingPalConversations.delete(palId)
			}
		}
	}
	async harnesses(projectId: string, sessionId?: string): Promise<HarnessView> {
		const project = this.project(projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		const session = sessionId ? this.session(sessionId) : undefined
		if (session && session.view.projectId !== projectId)
			throw new Error('This conversation belongs to another project.')
		if (session?.needsLoad) await this.reattach(session)
		const assertCurrent = this.metadataRead(project, session)
		const view = (await project.client.request(
			'namzu/harnesses/list',
			session ? { sessionId: session.runtimeSessionId } : {},
		)) as HarnessView
		assertCurrent()
		this.recordEngineTimings(view.timings)
		if (session) {
			if (session.view.harness !== view.selected)
				this.backgroundWork.invalidate(
					session.view.id,
					view.selected === 'namzu' ? { state: 'unknown' } : { state: 'unavailable' },
				)
			session.view.harness = view.selected
			this.persistDesktop()
		}
		return view
	}
	async selectHarness(sessionId: string, engine: HarnessView['selected']): Promise<HarnessView> {
		const session = this.session(sessionId)
		if (session.view.palId)
			throw new Error('External engines are available in normal conversations only.')
		if (!['namzu', 'codex-cli', 'claude-code'].includes(engine))
			throw new Error('Unknown execution engine.')
		if (
			session.running ||
			session.admitting ||
			session.queue.length ||
			this.changingPlugins.has(sessionId)
		)
			throw new Error('Stop this conversation before changing its engine.')
		this.changingPlugins.add(sessionId)
		session.selectionRevision = (session.selectionRevision ?? 0) + 1
		session.selectionPending = true
		try {
			if (session.needsLoad) await this.reattach(session, { engine })
			const assertCurrent = this.metadataRead(this.project(session.view.projectId), session, true)
			const previousEngine = session.view.harness
			const previousSelection = session.providerSelection
			const view = (await session.client.request('namzu/harnesses/select', {
				sessionId: session.runtimeSessionId,
				engine,
			})) as HarnessView
			assertCurrent()
			this.recordEngineTimings(view.timings)
			if (session.view.harness !== view.selected)
				this.backgroundWork.invalidate(
					sessionId,
					view.selected === 'namzu' ? { state: 'unknown' } : { state: 'unavailable' },
				)
			session.view.harness = view.selected
			session.providers = undefined
			session.providerSelection =
				previousEngine === view.selected && previousSelection?.provider === view.selected
					? previousSelection
					: undefined
			session.providerSetupFailure = undefined
			if (view.selected !== 'namzu') {
				try {
					const providers = (await session.client.request('namzu/providers/status', {
						sessionId: session.runtimeSessionId,
					})) as ProviderView
					assertCurrent()
					this.captureProviderSelection(session, providers)
					session.providers = providers
				} catch {
					assertCurrent()
					// The engine ACK remains authoritative when follow-up metadata is unavailable.
					session.providerSetupFailure =
						'The selected engine’s model settings could not be read. Retry model discovery or choose a model. Your draft is retained.'
				}
			}
			this.persistDesktop()
			this.trackBackgroundWork(sessionId)
			return view
		} finally {
			session.selectionPending = false
			this.changingPlugins.delete(sessionId)
		}
	}
	private metadataRead(project: Project, session?: Conversation, selecting = false): () => void {
		const client = project.client
		const runtimeId = session?.runtimeSessionId
		const revision = session?.selectionRevision ?? 0
		const assertCurrent = () => {
			if (
				this.closing ||
				this.projects.get(project.view.id) !== project ||
				project.view.status !== 'ready' ||
				(session && (session.client !== client || session.runtimeSessionId !== runtimeId))
			)
				throw new Error('The conversation settings changed while loading. Retry this request.')
			if (
				session &&
				((session.selectionRevision ?? 0) !== revision ||
					Boolean(session.selectionPending) !== selecting)
			)
				throw new SupersededConversationSettingsError()
		}
		assertCurrent()
		return assertCurrent
	}
	private captureProviderSelection(session: Conversation, providers: ProviderView): void {
		const engine = session.view.harness
		if (
			engine &&
			engine !== 'namzu' &&
			(providers.selected?.id !== engine || !providers.selected.model)
		)
			throw new Error('This engine did not report its selected model. Choose a model again.')
		if (providers.selected)
			session.providerSelection = {
				provider: providers.selected.id,
				...(providers.selected.model ? { model: providers.selected.model } : {}),
			}
		session.providerSetupFailure = undefined
		this.persistDesktop()
	}
	async openConversation(
		projectId: string,
		sessionId: string,
	): Promise<{
		messages: ChatMessage[]
		partial: boolean
		thread?: ThreadState
	}> {
		this.assertConversationAvailable(sessionId)
		const existing = this.conversations.get(sessionId)
		if (existing && existing.view.projectId !== projectId)
			throw new Error('This conversation belongs to another project.')
		if (existing && this.projects.get(projectId)?.view.status === 'error') {
			this.attachmentPreviews.touch(sessionId)
			return {
				messages: existing.projection.messages,
				partial: existing.projection.partial ?? false,
				thread: existing.projection,
			}
		}
		const project = this.project(projectId)
		if (!existing) {
			const assertCurrent = this.metadataRead(project)
			const indexed = project.conversationCatalogue?.get(sessionId)
			const list = indexed ? [indexed] : await this.listConversations(projectId)
			assertCurrent()
			this.assertConversationAvailable(sessionId)
			const view = list.find((row) => row.id === sessionId)
			if (!view) throw new Error('This conversation is no longer in this project.')
			const history = (await project.client.request('namzu/conversations/history', {
				sessionId,
			})) as {
				messages: ChatMessage[]
				partial: boolean
				work?: HistoryWorkSnapshot
			}
			assertCurrent()
			this.assertConversationAvailable(sessionId)
			const record: Conversation = {
				view,
				runtimeSessionId: sessionId,
				hasPrompted: true,
				needsLoad: true,
				needsHistory: false,
				client: project.client,
				running: false,
				queue: [],
				draft: '',
				projection: {
					...restoreHistoryWork(emptyThread(), history.messages, history.work),
					partial: history.partial,
				},
				permissions: new Map(),
			}
			this.conversations.set(sessionId, record)
			this.persistDesktop()
			this.trackBackgroundWork(sessionId)
			await this.refreshUndoQuietly(record)
			return {
				...history,
				messages: record.projection.messages,
				thread: record.projection,
			}
		}
		await this.restoreConversationHistory(existing)
		this.assertConversationAvailable(sessionId)
		this.attachmentPreviews.touch(sessionId)
		this.trackBackgroundWork(sessionId)
		// An unsent tab already owns its local draft and projection. Display it
		// immediately; readiness and metadata restore the exact engine/model
		// against its replacement runtime before admitting actions.
		// Active/transient sessions are rendered from their live UI projection.
		return {
			messages: existing.projection.messages,
			partial: existing.projection.partial ?? false,
			thread: existing.projection,
		}
	}
	/** Durable display does not require a provider context. Share the exact owned read with admission. */
	private async restoreConversationHistory(session: Conversation): Promise<void> {
		if (!session.needsHistory) return
		const project = this.project(session.view.projectId)
		const assertCurrent = this.metadataRead(project, session, Boolean(session.selectionPending))
		const client = session.client
		const runtimeId = session.runtimeSessionId
		const executionRevision = session.executionRevision ?? 0
		const selectionRevision = session.selectionRevision ?? 0
		const pending = session.historyRead
		if (
			pending?.client === client &&
			pending.runtimeId === runtimeId &&
			pending.executionRevision === executionRevision &&
			pending.selectionRevision === selectionRevision
		)
			return await pending.promise
		const promise = (async () => {
			const history = (await client.request('namzu/conversations/history', {
				sessionId: runtimeId,
			})) as {
				messages: ChatMessage[]
				partial: boolean
				work?: HistoryWorkSnapshot
			}
			assertCurrent()
			if (
				this.conversations.get(session.view.id) !== session ||
				(session.executionRevision ?? 0) !== executionRevision ||
				session.running
			)
				throw new Error('This conversation changed while opening. Open it again.')
			const attachmentIds = this.attachmentPreviews.forget(session.view.id)
			if (attachmentIds.length)
				this.emit({
					kind: 'attachment-previews-evicted',
					sessionId: session.view.id,
					attachmentIds,
				})
			session.projection = {
				...restoreHistoryWork(session.projection, history.messages, history.work),
				partial: history.partial,
			}
			session.needsHistory = false
			await this.refreshUndoQuietly(session)
		})()
		const reading = {
			client,
			runtimeId,
			executionRevision,
			selectionRevision,
			promise,
		}
		session.historyRead = reading
		try {
			await promise
		} finally {
			if (session.historyRead === reading) session.historyRead = undefined
		}
	}
	/** Readiness is separate from display; actions still perform their own fresh admission. */
	async readyConversation(projectId: string, sessionId: string): Promise<void> {
		const session = this.conversations.get(sessionId)
		if (!session) throw new Error('Open this conversation first.')
		if (session.view.projectId !== projectId)
			throw new Error('This conversation belongs to another project.')
		const project = this.project(projectId)
		if (session.needsLoad) await this.reattach(session)
		const assertCurrent = this.metadataRead(project, session)
		if (session.running || session.admitting) return
		const client = session.client
		const runtimeId = session.runtimeSessionId
		const executionRevision = session.executionRevision ?? 0
		const selectionRevision = session.selectionRevision ?? 0
		const pending = session.readyRead
		if (
			pending?.client === client &&
			pending.runtimeId === runtimeId &&
			pending.executionRevision === executionRevision &&
			pending.selectionRevision === selectionRevision
		)
			return await pending.promise
		const promise = Promise.all([this.readTasksSnapshot(session), this.refreshRetry(session)]).then(
			() => {
				assertCurrent()
				if ((session.executionRevision ?? 0) !== executionRevision || session.running)
					throw new Error('This turn changed while loading. Open it again.')
			},
		)
		const reading = {
			client,
			runtimeId,
			executionRevision,
			selectionRevision,
			promise,
		}
		session.readyRead = reading
		try {
			await promise
		} finally {
			if (session.readyRead === reading) session.readyRead = undefined
		}
	}
	private runtimeSession(project: Project, runtimeId: string): Conversation | undefined {
		return [...this.conversations.values()].find(
			(session) =>
				session.view.projectId === project.view.id &&
				session.client === project.client &&
				session.runtimeSessionId === runtimeId,
		)
	}
	private async reattach(
		session: Conversation,
		requested?: {
			engine: HarnessView['selected']
			provider?: string
			model?: string
		},
	): Promise<void> {
		if (!session.needsLoad) return
		await this.assertSettingsUnchanged(this.project(session.view.projectId))
		if (session.reattaching) return await session.reattaching
		const project = this.project(session.view.projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		const client = session.client
		const selectionRevision = session.selectionRevision ?? 0
		const engine = requested?.engine ?? session.view.harness
		const draftChoice = session.draftSettings?.choice
		const choice =
			requested !== undefined
				? requested.model
					? {
							provider: requested.provider ?? requested.engine,
							model: requested.model,
						}
					: undefined
				: draftChoice?.provider !== undefined &&
						(draftChoice.provider === engine ||
							((!engine || engine === 'namzu') &&
								!['codex-cli', 'claude-code'].includes(draftChoice.provider)))
					? draftChoice
					: session.providerSelection
		const stillOwned = () => {
			if ((session.selectionRevision ?? 0) !== selectionRevision)
				throw new Error('The conversation settings changed while loading. Retry this request.')
			if (session.client !== client || project.view.status !== 'ready')
				throw new Error('The connection changed while reopening this conversation.')
		}
		const operation = (async () => {
			if (session.hasPrompted) {
				await this.restoreConversationHistory(session)
				stillOwned()
				await client.request('session/load', {
					sessionId: session.runtimeSessionId,
					cwd: project.view.path,
				})
			} else {
				// A never-started session has no durable CLI history to load. Keep
				// its UI/draft owner and create only its replacement runtime slot.
				if (session.replacement?.client !== client) {
					const result = (await client.request('session/new', {
						cwd: project.view.path,
					})) as { sessionId: string }
					stillOwned()
					if (typeof result.sessionId !== 'string' || !result.sessionId)
						throw new Error('Namzu returned an invalid conversation identity.')
					const owner = this.runtimeSession(project, result.sessionId)
					if (owner && owner !== session)
						throw new Error('Namzu returned an identity owned by another conversation.')
					session.runtimeSessionId = result.sessionId
					this.backgroundWork.invalidate(session.view.id)
					session.replacement = { client, id: result.sessionId }
				}
				if (session.view.palId)
					await client.request('namzu/pals/conversations/claim', {
						palId: session.view.palId,
						sessionId: session.runtimeSessionId,
					})
				if (engine && engine !== 'namzu') {
					const restored = (await client.request('namzu/harnesses/select', {
						sessionId: session.runtimeSessionId,
						engine,
					})) as HarnessView
					stillOwned()
					if (restored.selected !== engine)
						throw new Error('The selected engine could not be restored. Your draft is retained.')
					if (choice?.provider === engine && choice.model) {
						await client.request('namzu/providers/select', {
							sessionId: session.runtimeSessionId,
							provider: choice.provider,
							model: choice.model,
						})
						stillOwned()
						session.providerSelection = {
							provider: choice.provider,
							model: choice.model,
						}
						session.providerSetupFailure = undefined
					} else if (requested) {
						// Explicit engine choice is confirmed independently of optional model metadata.
						session.providerSelection = undefined
					} else {
						throw new Error(
							session.providerSetupFailure ??
								'Choose a model for this engine again. Your draft is retained.',
						)
					}
					session.view.harness = engine
					this.backgroundWork.invalidate(session.view.id)
				} else if (requested) {
					const restored = (await client.request('namzu/harnesses/select', {
						sessionId: session.runtimeSessionId,
						engine: requested.engine,
					})) as HarnessView
					stillOwned()
					if (restored.selected !== requested.engine)
						throw new Error('The selected engine could not be restored. Your draft is retained.')
					session.view.harness = requested.engine
					this.backgroundWork.invalidate(session.view.id)
				}
				if (
					(!engine || engine === 'namzu') &&
					choice?.model &&
					!['codex-cli', 'claude-code'].includes(choice.provider)
				) {
					await client.request('namzu/providers/select', {
						sessionId: session.runtimeSessionId,
						provider: choice.provider,
						model: choice.model,
					})
					stillOwned()
					session.providerSelection = {
						provider: choice.provider,
						model: choice.model,
					}
				}
			}
			stillOwned()
			session.needsLoad = false
			session.restorePending = false
			session.replacement = undefined
			this.persistDesktop()
		})()
		session.reattaching = operation
		try {
			await operation
		} finally {
			if (session.reattaching === operation) session.reattaching = undefined
		}
	}
	/**
	 * One automatic attempt after the host dropped. It either clears the loss (new connection,
	 * stale error gone) or leaves the notice with a Reconnect button; it never loops.
	 */
	private async reconnectAfterLoss(projectId: string): Promise<void> {
		const lost = this.projects.get(projectId)
		if (!lost || this.closing) return
		lost.view.reconnecting = true
		this.emit({ kind: 'connection', project: { ...lost.view } })
		let next: ProjectView | undefined
		try {
			next = await this.reconnect(projectId)
		} catch {
			next = undefined
		}
		const current = this.projects.get(projectId)
		if (!current || this.closing) return
		if (next?.status === 'ready') return
		// Still down: keep the conversation, stop saying "reconnecting", offer the button.
		current.view.lost = true
		current.view.reconnecting = undefined
		this.emit({ kind: 'connection', project: { ...current.view } })
	}
	/** The connection is back: the line that said it was lost no longer describes anything. */
	private clearLostErrors(projectId: string): void {
		for (const session of this.conversations.values()) {
			if (session.view.projectId !== projectId || !session.connectionLost) continue
			session.connectionLost = false
			this.state(session, undefined, undefined, true)
		}
	}
	/** The sentence for a project whose folder was moved or deleted while Namzu had it open. */
	private folderMissingMessage(path: string): string {
		return `This folder no longer exists: ${path}`
	}
	/**
	 * A folder that vanished is not an untrusted folder: say so before any trust check can. The
	 * project becomes a failed one that names the missing path; the window offers to locate it or
	 * remove the project.
	 */
	private assertFolderPresent(projectId: string): void {
		const project = this.projects.get(projectId)
		if (!project || project.view.status !== 'ready' || existsSync(project.view.path)) return
		this.markFolderMissing(project)
		throw new Error(project.view.error)
	}
	private markFolderMissing(project: Project): void {
		project.view.missing = true
		project.view.status = 'error'
		project.view.error = this.folderMissingMessage(project.view.path)
		// Closing the host reports the failed project to every window.
		void this.closeClient(project.client)
	}
	async reconnect(id: string): Promise<ProjectView> {
		const project = this.projects.get(id)
		if (!project) throw new Error('Unknown project.')
		if (project.view.status !== 'error') return { ...project.view }
		if (!project.view.palId && !existsSync(project.view.path)) {
			project.view.missing = true
			project.view.error = this.folderMissingMessage(project.view.path)
			return { ...project.view }
		}
		if (project.view.palId) return (await this.openPal(project.view.palId)).project
		return this.openProject(project.view.path)
	}
	async providers(id: string, sessionId?: string): Promise<ProviderView> {
		const session = sessionId ? this.draftSession(sessionId) : undefined
		if (session && session.view.projectId !== id)
			throw new Error('This conversation belongs to another project.')
		const known = this.projects.get(id)
		if (known?.view.status === 'error')
			return session?.providers ?? known.providers ?? { available: [], selected: null }
		const project = this.project(id)
		if (session?.needsLoad) await this.reattach(session)
		const assertCurrent = this.metadataRead(project, session)
		const result = (await project.client.request(
			'namzu/providers/status',
			session ? { sessionId: session.runtimeSessionId } : {},
		)) as ProviderView
		assertCurrent()
		if (session) {
			this.captureProviderSelection(session, result)
			session.providers = result
		} else project.providers = result
		this.pruneModelLists(project, session, result)
		return result
	}
	/** A provider row that left the status (signed out) or changed takes its stored list along. */
	private pruneModelLists(
		project: Project,
		session: Conversation | undefined,
		status: ProviderView,
	): void {
		if (!this.modelLists || project.view.palId || !Array.isArray(status?.available)) return
		const keep = new Set<string>()
		for (const row of status.available) {
			const key = this.modelListKeyFor(project, session, row.id, status)
			if (key) keep.add(key)
		}
		this.modelLists.prune(session?.view.harness ?? 'namzu', keep)
	}
	async models(id: string, provider: string, sessionId?: string): Promise<ModelCatalogueView> {
		const project = this.project(id)
		if (typeof provider !== 'string' || !provider.trim() || provider.length > 400)
			throw new Error('Invalid provider.')
		const session = sessionId === undefined ? undefined : this.session(sessionId)
		if (session && session.view.projectId !== id)
			throw new Error('This conversation belongs to another project.')
		// A stored list answers at once; the CLI is asked in the background, never awaited.
		const stored = this.storedModels(project, session, provider)
		if (stored) {
			if (
				(!this.modelsRevalidated.has(stored.key) ||
					this.modelsStale.has(stored.key) ||
					Date.now() - stored.entry.fetchedAt > MODEL_LIST_MAX_AGE_MS) &&
				Date.now() >= (this.modelsRetryAt.get(stored.key) ?? 0)
			)
				void this.readModels(project, session, provider, stored.key).then(
					(read) => {
						// The stored rows stay; the failure is only a diagnostics line.
						if (!read.entry) this.modelReadFailed(stored.key)
					},
					(error: unknown) => {
						if (error instanceof SupersededConversationSettingsError) return
						this.modelReadFailed(stored.key, error)
					},
				)
			return this.storedView(stored.entry, session, provider)
		}
		let read: ModelRead
		try {
			read = await this.readModels(project, session, provider)
		} catch (error) {
			// A read shared with another conversation can be superseded by that one's change;
			// this caller's own state is unchanged, so it asks once more for itself.
			if (!(error instanceof SupersededConversationSettingsError)) throw error
			read = await this.readModels(project, session, provider)
		}
		return read.entry ? this.storedView(read.entry, session, provider) : read.view
	}
	/** Spawn, initialize and model-list costs of external engine starts, as the CLI measured them. */
	private recordEngineTimings(reports: EngineTimingReport[] | undefined): void {
		if (!Array.isArray(reports)) return
		for (const report of reports.slice(0, 16))
			this.diagnostics?.record('engine_timing', {
				engineId: report?.engine,
				step: report?.operation,
				timings: report?.timings,
			})
	}
	private modelReadFailed(key: string, error?: unknown): void {
		// A source that keeps failing is tried again after a minute, not on every picker open.
		this.modelsRetryAt.set(key, Date.now() + MODEL_RETRY_AFTER_MS)
		this.diagnostics?.record('cli_request_failed', {
			operation: 'models',
			...(error === undefined ? {} : { error }),
		})
	}
	/** Resolves once no model list read is running; a test seam for the background refresh. */
	async modelReadsSettled(): Promise<void> {
		while (this.modelReads.size) await Promise.allSettled([...this.modelReads.values()])
	}
	/** The list kept for this provider, when the cached provider status can name its key. */
	private storedModels(
		project: Project,
		session: Conversation | undefined,
		provider: string,
	): { key: string; entry: StoredModelList } | undefined {
		const key = this.modelListKeyFor(project, session, provider)
		const entry = key ? this.modelLists?.get(key) : undefined
		return key && entry ? { key, entry } : undefined
	}
	private modelListKeyFor(
		project: Project,
		session: Conversation | undefined,
		provider: string,
		status = session ? session.providers : project.providers,
	): string | undefined {
		// A Pal reads its own provider set, which the key does not describe; it is always live.
		const row = project.view.palId
			? undefined
			: status?.available.find((item) => item.id === provider)
		return row
			? modelListKey({
					engine: session?.view.harness ?? 'namzu',
					id: row.id,
					label: row.label,
					...(row.identity ? { identity: row.identity } : {}),
				})
			: undefined
	}
	private storedView(
		entry: StoredModelList,
		session: Conversation | undefined,
		provider: string,
	): ModelCatalogueView {
		const models = entry.rows.models.map((model) =>
			Object.hasOwn(entry.firstSeen, model.id)
				? { ...model, firstSeen: entry.firstSeen[model.id] }
				: model,
		)
		// The selected-model warning belongs to the conversation, so it is never stored.
		const selected = session?.providers?.selected
		const engine = session?.view.harness ?? 'namzu'
		const missing =
			engine === 'namzu' &&
			entry.rows.notice === null &&
			selected?.id === provider &&
			selected.model !== undefined &&
			!models.some((model) => model.id === selected.model)
		return {
			models,
			notice: missing
				? 'The selected model is not in this catalogue. Choose a listed model or another provider.'
				: entry.rows.notice,
			fetchedAt: entry.fetchedAt,
		}
	}
	/** One CLI read per key at a time; a successful, non-empty list is stored. */
	private readModels(
		project: Project,
		session: Conversation | undefined,
		provider: string,
		knownKey?: string,
	): Promise<ModelRead> {
		const keyed = knownKey ?? this.modelListKeyFor(project, session, provider)
		const running = keyed ? this.modelReads.get(keyed) : undefined
		if (running) return running
		const operation = (async (): Promise<ModelRead> => {
			if (session?.needsLoad) await this.reattach(session)
			const assertCurrent = this.metadataRead(project, session)
			const view = (await project.client.request('namzu/providers/models', {
				provider,
				...(session ? { sessionId: session.runtimeSessionId } : {}),
			})) as ModelCatalogueView
			assertCurrent()
			this.recordEngineTimings(view?.timings)
			let key = keyed
			// A failed listing arrives as a notice with no rows. It is shown, never kept.
			if (!this.modelLists || !Array.isArray(view?.models) || !view.models.length) return { view }
			if (!key) {
				// The renderer reads provider status first, so this is the rare cold path.
				const status = (await project.client.request(
					'namzu/providers/status',
					session ? { sessionId: session.runtimeSessionId } : {},
				)) as ProviderView
				assertCurrent()
				key = this.modelListKeyFor(project, session, provider, status)
			}
			if (!key) return { view }
			// Only a usable list counts as this run's revalidation; a failed read is tried again.
			this.modelsRevalidated.add(key)
			this.modelsRetryAt.delete(key)
			this.modelsStale.delete(key)
			// The warning that the selected model is missing is per conversation; keep only
			// what describes the list itself.
			const notice = view.notice === TRUNCATED_MODEL_NOTICE ? view.notice : null
			const { changed, entry } = this.modelLists.put(key, {
				models: view.models,
				notice,
			})
			if (changed)
				this.emit({
					kind: 'model-catalogue-updated',
					engine: session?.view.harness ?? 'namzu',
					provider,
				})
			return { view, entry }
		})()
		if (keyed) {
			this.modelReads.set(keyed, operation)
			const clear = () => {
				if (this.modelReads.get(keyed) === operation) this.modelReads.delete(keyed)
			}
			operation.then(clear, clear)
		}
		return operation
	}
	/** A model the CLI refused means the stored list is out of date for the next read. */
	private markModelsStale(session: Conversation, provider: string): void {
		const project = this.projects.get(session.view.projectId)
		const key = project ? this.modelListKeyFor(project, session, provider) : undefined
		if (key) this.modelsStale.add(key)
	}
	async modelSettings(
		id: string,
		provider: string,
		model: string,
		sessionId?: string,
	): Promise<ComposerModelSettings> {
		const project = this.project(id)
		if (
			typeof provider !== 'string' ||
			!provider.trim() ||
			provider.length > 400 ||
			typeof model !== 'string' ||
			!model.trim() ||
			model.length > 400
		)
			throw new Error('Invalid model choice.')
		const session = sessionId === undefined ? undefined : this.session(sessionId)
		if (session && session.view.projectId !== id)
			throw new Error('This conversation belongs to another project.')
		if (session?.needsLoad) await this.reattach(session)
		const assertCurrent = this.metadataRead(project, session)
		const result = (await project.client.request('namzu/providers/settings', {
			provider,
			model,
			...(session ? { sessionId: session.runtimeSessionId } : {}),
		})) as ComposerModelSettings
		assertCurrent()
		return result
	}
	async plugins(id: string, sessionId?: string): Promise<PluginInventoryView> {
		const project = this.project(id)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		const session = sessionId === undefined ? undefined : this.session(sessionId)
		if (session && session.view.projectId !== id)
			throw new Error('This conversation belongs to another project.')
		if (session?.needsLoad) await this.reattach(session)
		const assertCurrent = this.metadataRead(project, session)
		const result = (await project.client.request(
			'namzu/plugins/list',
			session ? { sessionId: session.runtimeSessionId } : {},
		)) as PluginInventoryView
		assertCurrent()
		return result
	}
	async setPluginEnabled(
		sessionId: string,
		name: string,
		enabled: boolean,
	): Promise<PluginInventoryView> {
		const session = this.session(sessionId)
		if (
			session.running ||
			session.admitting ||
			session.permissions.size ||
			this.changingPlugins.has(sessionId)
		)
			throw new Error('Stop this conversation’s active work before changing plugins.')
		if (
			typeof name !== 'string' ||
			!name.trim() ||
			name.length > 400 ||
			typeof enabled !== 'boolean'
		)
			throw new Error('Invalid plugin choice.')
		await this.assertSettingsUnchanged(this.project(session.view.projectId))
		this.changingPlugins.add(sessionId)
		session.selectionRevision = (session.selectionRevision ?? 0) + 1
		try {
			return (await session.client.request('namzu/plugins/set_enabled', {
				sessionId: session.runtimeSessionId,
				name,
				enabled,
			})) as PluginInventoryView
		} finally {
			this.changingPlugins.delete(sessionId)
		}
	}
	async selectProvider(sessionId: string, provider: string, model?: string): Promise<void> {
		const session = this.session(sessionId)
		if (
			typeof provider !== 'string' ||
			provider.length > 400 ||
			(model !== undefined && (typeof model !== 'string' || model.length > 400))
		)
			throw new Error('Invalid model choice.')
		if (session.running || session.admitting || this.changingPlugins.has(sessionId))
			throw new Error('Stop this conversation before changing its model.')
		this.changingPlugins.add(sessionId)
		session.selectionRevision = (session.selectionRevision ?? 0) + 1
		session.selectionPending = true
		try {
			if (session.needsLoad)
				await this.reattach(
					session,
					provider === session.view.harness && provider !== 'namzu'
						? {
								engine: provider,
								...(model?.trim() ? { model: model.trim() } : {}),
							}
						: session.view.harness === undefined || session.view.harness === 'namzu'
							? {
									engine: 'namzu',
									provider,
									...(model?.trim() ? { model: model.trim() } : {}),
								}
							: undefined,
				)
			const assertCurrent = this.metadataRead(this.project(session.view.projectId), session, true)
			try {
				await session.client.request('namzu/providers/select', {
					sessionId: session.runtimeSessionId,
					provider,
					...(model?.trim() ? { model: model.trim() } : {}),
				})
			} catch (error) {
				// The CLI refused this choice, so the list that offered it may be out of date.
				if (model?.trim()) this.markModelsStale(session, provider)
				throw error
			}
			assertCurrent()
			session.providerSelection = {
				provider,
				...(model?.trim() ? { model: model.trim() } : {}),
			}
			session.providerSetupFailure = undefined
			this.persistDesktop()
		} finally {
			session.selectionPending = false
			this.changingPlugins.delete(sessionId)
		}
	}
	private attachmentProject(ownerId: string): string {
		this.draftOwner(ownerId)
		return projectDraftOwner(ownerId)?.projectId ?? this.draftSession(ownerId).view.projectId
	}
	attachments(ownerId: string): AttachmentView[] {
		this.attachmentProject(ownerId)
		return [...this.attachmentFiles.values()]
			.filter((file) => file.ownerId === ownerId && file.draft)
			.map((file) => ({ ...file.view }))
	}
	addAttachments(ownerId: string, input: AttachmentInput[]): AttachmentView[] {
		const projectId = this.attachmentProject(ownerId)
		if (!this.project(projectId).view.trusted)
			throw new Error('Trust this folder before attaching files.')
		if (!Array.isArray(input) || input.length > MAX_ATTACHMENT_COUNT)
			throw new Error('Attach at most eight files.')
		const incoming = input.map(admitAttachment)
		const existing = [...this.attachmentFiles.values()].filter(
			(file) => file.ownerId === ownerId && file.draft,
		)
		validateAttachmentBatch([...existing, ...incoming])
		const retainedBytes = [...this.attachmentFiles.values()].reduce(
			(total, file) => total + file.view.size,
			0,
		)
		if (
			retainedBytes + incoming.reduce((total, file) => total + file.view.size, 0) >
			24 * 1024 * 1024
		)
			throw new Error('Attachment storage is full. Remove pending attachments before adding more.')
		for (const file of incoming)
			this.attachmentFiles.set(file.view.id, { ...file, ownerId, draft: true })
		this.persistDesktop()
		return this.attachments(ownerId)
	}
	async addChosenFiles(ownerId: string, paths: string[]): Promise<AttachmentView[]> {
		this.attachmentProject(ownerId)
		if (!Array.isArray(paths) || paths.length > MAX_ATTACHMENT_COUNT)
			throw new Error('Attach at most eight files.')
		const files: AttachmentInput[] = []
		for (const path of paths) files.push(await readChosenFile(path))
		return this.addAttachments(ownerId, files)
	}
	removeAttachment(ownerId: string, id: string): void {
		this.attachmentProject(ownerId)
		const file = this.attachmentFiles.get(id)
		if (!file || file.ownerId !== ownerId || !file.draft)
			throw new Error('This attachment no longer belongs to this draft.')
		this.attachmentFiles.delete(id)
		this.persistDesktop()
	}
	moveAttachments(fromOwner: string, toSessionId: string): AttachmentView[] {
		const projectId = this.attachmentProject(fromOwner)
		const target = this.draftSession(toSessionId)
		if (target.view.projectId !== projectId)
			throw new Error('This conversation belongs to another project.')
		const files = [...this.attachmentFiles.values()].filter(
			(file) => file.ownerId === fromOwner && file.draft,
		)
		const existing = [...this.attachmentFiles.values()].filter(
			(file) => file.ownerId === toSessionId && file.draft,
		)
		validateAttachmentBatch([...new Set([...existing, ...files])])
		for (const file of files) file.ownerId = toSessionId
		this.persistDesktop()
		return this.attachments(toSessionId)
	}
	private assertPalAdmission(palId?: string, computerWork = false): void {
		if (!palId) return
		this.assertPalAvailable(palId)
		if (this.changingPals.has(palId)) throw new Error('Wait for this Pal’s changes to finish.')
		if (computerWork && this.operatorComputers.has(palId))
			throw new Error('Return this Pal computer’s control before sending a message.')
		if (this.palRecords.get(palId)?.paused)
			throw new Error('Resume this Pal before sending a message.')
	}
	private async liveInputStatus(
		session: Conversation,
		client: RuntimeClient,
		runtimeId: string,
		scopeId?: string,
	): Promise<LiveInputStatus> {
		const result = await client.request(
			'namzu/conversations/input/status',
			{ sessionId: runtimeId, ...(scopeId ? { scopeId } : {}) },
			8_000,
		)
		if (session.client !== client || session.runtimeSessionId !== runtimeId)
			throw new Error('The conversation connection changed while sending. Your draft is retained.')
		const status = readLiveInputStatus(result)
		if (scopeId && status.scopeId !== scopeId)
			throw new Error('Namzu returned a different live input scope.')
		return status
	}
	private async refreshLiveInputs(session: Conversation): Promise<LiveInputStatus | undefined> {
		if (!session.liveInputs?.size) return
		if (session.liveInputRead) return session.liveInputRead
		const client = session.client
		const runtimeId = session.runtimeSessionId
		const revision = session.executionRevision ?? 0
		const scopeId = [...session.liveInputs.values()][0]?.scopeId
		if (!scopeId) return undefined
		const read = (async () => {
			const status = await this.liveInputStatus(session, client, runtimeId, scopeId)
			if (
				this.conversations.get(session.view.id) !== session ||
				session.executionRevision !== revision
			)
				return undefined
			for (const receipt of session.liveInputs?.values() ?? []) {
				if (receipt.scopeId !== scopeId || receipt.status === 'delivered') continue
				const observed = status.inputs.find((item) => item.id === receipt.id)?.status
				if (!observed) continue
				if (receipt.unknown) {
					receipt.unknown = false
					this.emit({
						kind: 'live-input',
						sessionId: session.view.id,
						inputId: receipt.id,
						prompt: receipt.prompt,
						status: 'pending',
					})
				}
				if (observed !== 'delivered') continue
				receipt.status = 'delivered'
				if (session.draft === receipt.prompt && session.draftRevision === receipt.draftRevision) {
					session.draft = ''
					this.persistDesktop()
				}
				this.emit({
					kind: 'live-input',
					sessionId: session.view.id,
					inputId: receipt.id,
					prompt: receipt.prompt,
					status: 'delivered',
				})
			}
			return status
		})()
		session.liveInputRead = read
		try {
			return await read
		} finally {
			if (session.liveInputRead === read) session.liveInputRead = undefined
		}
	}
	async sendCurrent(
		sessionId: string,
		prompt: string,
		options?: DesktopSendOptions,
	): Promise<'accepted' | 'queued'> {
		const session = this.session(sessionId)
		this.assertFolderPresent(session.view.projectId)
		if (session.admitting) throw new Error('Wait for this conversation’s admission to finish.')
		if (this.changingPlugins.has(sessionId))
			throw new Error('Wait for this conversation’s settings change to finish.')
		if (
			options !== undefined &&
			(!options || typeof options !== 'object' || Array.isArray(options))
		)
			throw new Error('Invalid message options.')
		if (
			options?.effort !== undefined &&
			(typeof options.effort !== 'string' ||
				!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
					options.effort,
				))
		)
			throw new Error('Invalid reasoning effort.')
		if (
			options?.permissionMode !== undefined &&
			!['prompt', 'accept-edits', 'auto', 'strict', 'plan'].includes(options.permissionMode)
		)
			throw new Error('Invalid permission mode.')
		if (
			options?.attachmentIds !== undefined &&
			(!Array.isArray(options.attachmentIds) ||
				options.attachmentIds.length > MAX_ATTACHMENT_COUNT ||
				new Set(options.attachmentIds).size !== options.attachmentIds.length)
		)
			throw new Error('Invalid attachments.')
		if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50_000)
			throw new Error('Enter a message under 50,000 characters.')
		if (!session.running) await this.assertSettingsUnchanged(this.project(session.view.projectId))
		if (
			!session.running ||
			!!session.projection.stopReason ||
			session.view.palId ||
			(session.view.harness && session.view.harness !== 'namzu') ||
			options?.attachmentIds?.length ||
			!session.client.supportsLiveInput()
		) {
			await this.send(sessionId, prompt, options)
			return 'queued'
		}
		const client = session.client
		const runtimeId = session.runtimeSessionId
		const revision = session.executionRevision ?? 0
		const draftRevision = session.draftRevision ?? 0
		const assertCurrent = () => {
			const project = this.project(session.view.projectId)
			if (
				this.closing ||
				this.conversations.get(sessionId) !== session ||
				!session.running ||
				!!session.projection.stopReason ||
				session.client !== client ||
				session.runtimeSessionId !== runtimeId ||
				session.executionRevision !== revision ||
				project.client !== client ||
				project.view.status !== 'ready' ||
				!project.view.trusted ||
				session.view.palId ||
				(session.view.harness && session.view.harness !== 'namzu')
			)
				throw new Error('The running conversation changed. Your draft is retained.')
		}
		const operation = (async (): Promise<'accepted' | 'queued'> => {
			assertCurrent()
			if (session.queue.length + (session.liveInputs?.size ?? 0) >= 20)
				throw new Error('The message queue is full.')
			const predecessors = [
				...session.queue.map((item) => item.id),
				...[...(session.liveInputs?.values() ?? [])].map((item) => item.id),
			]
			const status = await this.liveInputStatus(session, client, runtimeId)
			assertCurrent()
			if (!status.available || !status.scopeId) {
				await this.send(sessionId, prompt, options)
				return 'queued'
			}
			const scopeId = status.scopeId
			const previous = session.liveInputRetry
			const inputId =
				previous &&
				previous.client === client &&
				previous.runtimeId === runtimeId &&
				previous.executionRevision === revision &&
				previous.scopeId === scopeId &&
				previous.draftRevision === draftRevision &&
				previous.prompt === prompt
					? previous.id
					: randomUUID()
			session.liveInputRetry = {
				id: inputId,
				prompt,
				scopeId,
				draftRevision,
				client,
				runtimeId,
				executionRevision: revision,
			}
			const receipt: LiveInputReceipt = session.liveInputs?.get(inputId) ?? {
				id: inputId,
				prompt,
				scopeId,
				status: 'pending',
				unknown: true,
				predecessors,
				draftRevision,
				...(options ? { options: resolveComposerSendOptions(options) } : {}),
			}
			if (!session.liveInputs) session.liveInputs = new Map()
			session.liveInputs.set(inputId, receipt)
			// Anchor the authored input before dispatch. A provider update can overtake
			// its ACK or the later delivery-status read.
			this.emit({
				kind: 'live-input',
				sessionId,
				inputId,
				prompt,
				status: 'unknown',
			})
			let acceptedStatus = status.inputs.find((item) => item.id === inputId)?.status
			try {
				if (!acceptedStatus) {
					const reply = (await client.request(
						'namzu/conversations/input',
						{ sessionId: runtimeId, scopeId, inputId, prompt },
						8_000,
					)) as Record<string, unknown>
					if (reply?.accepted !== true || reply.scopeId !== scopeId || reply.inputId !== inputId)
						throw new Error('Namzu did not confirm this live message.')
					acceptedStatus = 'pending'
				}
			} catch (error) {
				// The exact attempt exists before dispatch. A lost ACK plus a failed
				// status read must remain visible to settlement as an unknown delivery.
				try {
					const known = await this.liveInputStatus(session, client, runtimeId, scopeId)
					acceptedStatus = known.inputs.find((item) => item.id === inputId)?.status
				} catch {
					this.emit({
						kind: 'live-input',
						sessionId,
						inputId,
						prompt,
						status: 'unknown',
					})
					throw error
				}
				if (!acceptedStatus) {
					session.liveInputs.delete(inputId)
					session.liveInputRetry = undefined
					this.emit({
						kind: 'live-input',
						sessionId,
						inputId,
						prompt,
						status: 'queued',
					})
					throw error
				}
			}
			if (
				this.conversations.get(sessionId) !== session ||
				session.client !== client ||
				session.runtimeSessionId !== runtimeId ||
				session.executionRevision !== revision
			)
				throw new Error(
					'The conversation changed after live input admission. Its delivery is being reconciled.',
				)
			receipt.unknown = false
			receipt.status = acceptedStatus ?? 'pending'
			session.liveInputRetry = undefined
			if (session.draft === prompt && session.draftRevision === draftRevision) {
				session.draft = ''
				this.persistDesktop()
			}
			this.emit({
				kind: 'live-input',
				sessionId,
				inputId,
				prompt,
				status: 'pending',
			})
			if (receipt.status === 'delivered') {
				this.emit({
					kind: 'live-input',
					sessionId,
					inputId,
					prompt,
					status: 'delivered',
				})
			} else {
				session.liveInputReadOnNextUpdate = true
				// Read again at a model or tool boundary, then at settlement.
			}
			return 'accepted'
		})()
		if (!session.liveInputCalls) session.liveInputCalls = new Set()
		const calls = session.liveInputCalls
		calls.add(operation)
		try {
			return await operation
		} finally {
			calls.delete(operation)
		}
	}
	send(sessionId: string, prompt: string, options?: DesktopSendOptions): void | Promise<void> {
		const session = this.session(sessionId)
		this.assertFolderPresent(session.view.projectId)
		if (session.admitting) throw new Error('Wait for this conversation’s admission to finish.')
		this.assertPalAdmission(session.view.palId)
		if (this.changingPlugins.has(sessionId))
			throw new Error('Wait for this conversation’s settings change to finish.')
		if (
			options !== undefined &&
			(!options || typeof options !== 'object' || Array.isArray(options))
		)
			throw new Error('Invalid message options.')
		const ids = options?.attachmentIds ?? []
		if (session.view.harness && session.view.harness !== 'namzu') {
			if (ids.length)
				throw new Error(
					'This engine connection does not support attachments yet. Your draft is retained.',
				)
			const supportedReviewModes =
				session.view.harness === 'codex-cli'
					? ['prompt', 'plan', 'accept-edits', 'auto', 'strict']
					: ['prompt', 'plan']
			if (options?.permissionMode && !supportedReviewModes.includes(options.permissionMode))
				throw new Error(
					session.view.harness === 'claude-code'
						? 'This engine supports Ask first and Plan only.'
						: 'This engine does not support the selected permission mode.',
				)
		}
		if (
			!Array.isArray(ids) ||
			ids.length > MAX_ATTACHMENT_COUNT ||
			new Set(ids).size !== ids.length
		)
			throw new Error('Invalid attachments.')
		const files = ids.map((id) => {
			const file = this.attachmentFiles.get(id)
			if (
				!file ||
				!file.draft ||
				(file.ownerId !== sessionId && file.ownerId !== `project:${session.view.projectId}`)
			)
				throw new Error('This attachment belongs to another draft.')
			return file
		})
		validateAttachmentBatch(files)
		if (files.some((file) => file.image) && !session.client.supportsPromptAttachments())
			throw new Error('Update Namzu to a version that can receive image attachments.')
		if (
			options?.effort !== undefined &&
			(typeof options.effort !== 'string' ||
				!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
					options.effort,
				))
		)
			throw new Error('Invalid reasoning effort.')
		if (
			options?.permissionMode !== undefined &&
			!['prompt', 'accept-edits', 'auto', 'strict', 'plan'].includes(options.permissionMode)
		)
			throw new Error('Invalid permission mode.')
		if (
			(options?.effort !== undefined ||
				(options?.permissionMode !== undefined && options.permissionMode !== 'prompt')) &&
			!session.client.supportsPromptOptions()
		)
			throw new Error('Update Namzu to a version that can apply message settings.')
		if (typeof prompt !== 'string' || (!prompt.trim() && !files.length) || prompt.length > 50_000)
			throw new Error('Enter a message under 50,000 characters.')
		const captured: PendingMessage = {
			id: randomUUID(),
			prompt,
			files,
			draftRevision: session.draftRevision ?? 0,
			...(options || session.view.palId
				? {
						options: resolveComposerSendOptions(options, session.view.palId),
					}
				: {}),
		}
		if (session.running) {
			if (session.queue.length >= 20) throw new Error('The message queue is full.')
			for (const file of files) {
				file.draft = false
				file.ownerId = sessionId
			}
			session.queue.push(captured)
			// A newer admitted queue item owns the empty composer. An earlier
			// preflight failure must not put its prompt back over that ownership.
			session.draftRevision = (session.draftRevision ?? 0) + 1
			captured.draftRevision = session.draftRevision
			if (session.draft === prompt) session.draft = ''
			this.state(session)
			return
		}
		if (session.client.supportsTurnRetry()) {
			const admission = Symbol('prompt admission')
			const selectionRevision = session.selectionRevision ?? 0
			session.admitting = admission
			return (async () => {
				await this.reattach(session)
				const assertCurrent = this.metadataRead(this.project(session.view.projectId), session)
				const status = await this.refreshRetry(session)
				assertCurrent()
				if (
					session.admitting !== admission ||
					(session.selectionRevision ?? 0) !== selectionRevision ||
					this.changingPlugins.has(sessionId)
				)
					throw new Error(
						'This conversation’s settings changed during admission. Your draft is retained.',
					)
				if (status.retry || status.notice || session.projection.reason === 'paused')
					throw new Error(
						status.notice ??
							'This conversation has a paused turn. Retry it before sending a new message. Your draft is retained.',
					)
				this.assertPalAdmission(session.view.palId)
				this.admitMessage(session, captured)
			})().finally(() => {
				if (session.admitting === admission) session.admitting = undefined
			})
		}
		if (session.projection.reason === 'paused')
			throw new Error(
				'This conversation has a paused turn. Your draft is retained; update Namzu to retry it.',
			)
		this.admitMessage(session, captured)
	}
	private admitMessage(session: Conversation, captured: PendingMessage): void {
		const { prompt, files } = captured
		for (const file of files) {
			file.draft = false
			file.ownerId = session.view.id
		}
		if (session.draft === prompt) session.draft = ''
		this.startRun(session, captured)
	}
	private async refreshRetry(session: Conversation): Promise<DesktopRetryStatus> {
		const client = session.client
		const runtimeId = session.runtimeSessionId
		const executionRevision = session.executionRevision ?? 0
		const selectionRevision = session.selectionRevision ?? 0
		const result = client.supportsTurnRetry()
			? await client.request('namzu/sessions/retry-status', {
					sessionId: runtimeId,
				})
			: {}
		if (
			this.closing ||
			this.conversations.get(session.view.id) !== session ||
			this.projects.get(session.view.projectId)?.client !== client ||
			this.projects.get(session.view.projectId)?.view.status !== 'ready' ||
			session.client !== client ||
			session.runtimeSessionId !== runtimeId
		)
			throw new Error('The connection changed while reading this turn’s retry status.')
		if (!result || typeof result !== 'object' || Array.isArray(result))
			throw new Error('Namzu returned an invalid turn retry status.')
		const { retry, notice } = result as DesktopRetryStatus
		if (
			(retry !== undefined &&
				(!retry ||
					typeof retry !== 'object' ||
					typeof retry.turnId !== 'string' ||
					!retry.turnId ||
					retry.turnId.length > 200 ||
					typeof retry.checkpointId !== 'string' ||
					!retry.checkpointId ||
					retry.checkpointId.length > 200)) ||
			(notice !== undefined && (typeof notice !== 'string' || notice.length > 2_000))
		)
			throw new Error('Namzu returned an invalid turn retry status.')
		if ((session.executionRevision ?? 0) !== executionRevision || session.running)
			throw new Error('This turn changed while reading its retry status. Open it again.')
		if (
			(session.selectionRevision ?? 0) !== selectionRevision ||
			session.selectionPending ||
			this.changingPlugins.has(session.view.id)
		)
			throw new Error(
				'This conversation’s settings changed while reading retry status. Open it again.',
			)
		if (
			JSON.stringify(session.projection.retry) !== JSON.stringify(retry) ||
			session.projection.retryNotice !== notice
		)
			this.emit({
				kind: 'retry-status',
				sessionId: session.view.id,
				retry,
				notice,
			})
		return { ...(retry ? { retry } : {}), ...(notice ? { notice } : {}) }
	}
	private async readTasksSnapshot(session: Conversation, force = false): Promise<void> {
		const client = session.client
		if (
			this.closing ||
			this.projects.get(session.view.projectId)?.view.status !== 'ready' ||
			!client.supportsTasks() ||
			(session.view.harness && session.view.harness !== 'namzu')
		)
			return
		if (session.taskRead) {
			const current = await session.taskRead
			if (force || !current) await this.readTasksSnapshot(session, force)
			return
		}
		if (!force && session.tasksClient === client) return
		if (!session.hasPrompted) {
			session.tasksClient = client
			return
		}
		const runtimeId = session.runtimeSessionId
		const taskRevision = session.taskRevision ?? 0
		const executionRevision = session.executionRevision ?? 0
		const current = () =>
			!this.closing &&
			this.conversations.get(session.view.id) === session &&
			session.client === client &&
			session.runtimeSessionId === runtimeId &&
			this.projects.get(session.view.projectId)?.client === client &&
			this.projects.get(session.view.projectId)?.view.status === 'ready' &&
			(session.taskRevision ?? 0) === taskRevision &&
			(session.executionRevision ?? 0) === executionRevision
		const operation = (async () => {
			try {
				const result = await client.request('namzu/tasks/list', {
					sessionId: runtimeId,
				})
				if (!current()) return false
				const tasks = readTasks(result)
				if (!tasks) throw new Error('Invalid task list.')
				session.tasksClient = client
				this.emit({ kind: 'tasks', sessionId: session.view.id, tasks })
				return true
			} catch (error) {
				if (current()) {
					try {
						this.diagnostics?.record('cli_notice', {
							operation: 'namzu/tasks/list',
							error,
						})
					} catch {
						/* Diagnostics cannot break task readout or prompt settlement. */
					}
					this.emit({
						kind: 'tasks',
						sessionId: session.view.id,
						notice: 'Task list unavailable. Retained task states may be out of date.',
					})
				}
				return current()
			}
		})()
		session.taskRead = operation
		try {
			await operation
		} finally {
			if (session.taskRead === operation) session.taskRead = undefined
		}
	}
	async retryTurn(
		sessionId: string,
		turnId: string,
		checkpointId: string,
		options?: Omit<DesktopSendOptions, 'attachmentIds'>,
	): Promise<void> {
		const session = this.session(sessionId)
		if (session.running || session.admitting || this.changingPlugins.has(sessionId))
			throw new Error('Wait for this conversation’s active work to finish.')
		if (!session.client.supportsTurnRetry()) throw new Error('Update Namzu to retry paused turns.')
		this.assertPalAdmission(session.view.palId, true)
		if (
			options !== undefined &&
			(!options ||
				typeof options !== 'object' ||
				Array.isArray(options) ||
				Object.keys(options).some((key) => key !== 'effort' && key !== 'permissionMode') ||
				(options.effort !== undefined &&
					!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
						options.effort,
					)) ||
				(options.permissionMode !== undefined &&
					!['prompt', 'accept-edits', 'auto', 'strict', 'plan'].includes(options.permissionMode)))
		)
			throw new Error('Invalid retry settings.')
		const admission = Symbol('retry admission')
		const selectionRevision = session.selectionRevision ?? 0
		session.admitting = admission
		try {
			await this.reattach(session)
			const assertCurrent = this.metadataRead(this.project(session.view.projectId), session)
			const status = await this.refreshRetry(session)
			assertCurrent()
			if (
				session.admitting !== admission ||
				(session.selectionRevision ?? 0) !== selectionRevision ||
				this.changingPlugins.has(sessionId)
			)
				throw new Error('This conversation’s settings changed during retry admission.')
			if (status.retry?.turnId !== turnId || status.retry.checkpointId !== checkpointId)
				throw new Error(
					status.notice ??
						'This checkpoint is no longer available for retry. Open the conversation again.',
				)
			this.assertPalAdmission(session.view.palId, true)
			session.running = true
			session.executionRevision = (session.executionRevision ?? 0) + 1
			const running = this.runRetry(session, turnId, checkpointId, options)
			session.runSettled = running
			const clear = () => {
				if (session.runSettled === running) session.runSettled = undefined
			}
			void running.then(clear, clear)
		} finally {
			if (session.admitting === admission) session.admitting = undefined
		}
	}
	/** Undo state is the CLI's to say. A failed or stale read leaves what the card already shows. */
	private async refreshUndo(session: Conversation, turnIds?: string[]): Promise<void> {
		const client = session.client
		const runtimeId = session.runtimeSessionId
		if (!client.supportsTurnUndo() || !session.hasPrompted) return
		if (turnIds?.length === 0) return
		const result = await client.request('namzu/turns/undo-status', {
			sessionId: runtimeId,
			...(turnIds ? { turnIds } : {}),
		})
		if (
			this.closing ||
			this.conversations.get(session.view.id) !== session ||
			session.client !== client ||
			session.runtimeSessionId !== runtimeId
		)
			return
		const turns = readUndoStatus(result)
		if (!turns) throw new Error('Namzu returned an invalid undo status.')
		this.emit({ kind: 'undo-status', sessionId: session.view.id, turns })
	}
	private async refreshUndoQuietly(session: Conversation): Promise<void> {
		try {
			await this.refreshUndo(session)
		} catch (error) {
			try {
				this.diagnostics?.record('cli_notice', {
					operation: 'namzu/turns/undo-status',
					error,
				})
			} catch {
				/* Diagnostics cannot break opening a conversation. */
			}
		}
	}
	async undoStatus(sessionId: string, turnIds?: string[]): Promise<void> {
		const session = this.session(sessionId)
		if (
			turnIds !== undefined &&
			(!Array.isArray(turnIds) ||
				turnIds.length > 500 ||
				turnIds.some((id) => typeof id !== 'string' || !id || id.length > 200))
		)
			throw new Error('Invalid turns.')
		await this.refreshUndo(session, turnIds)
	}
	async undoPreview(
		sessionId: string,
		turnId: string,
		options?: { alsoUndoLater?: boolean },
	): Promise<DesktopUndoPreview> {
		const session = this.session(sessionId)
		if (!session.client.supportsTurnUndo()) throw new Error('Update Namzu to undo a reply.')
		if (typeof turnId !== 'string' || !turnId || turnId.length > 200)
			throw new Error('Invalid turn.')
		if (
			options !== undefined &&
			(!options ||
				typeof options !== 'object' ||
				Array.isArray(options) ||
				Object.keys(options).some((key) => key !== 'alsoUndoLater') ||
				(options.alsoUndoLater !== undefined && typeof options.alsoUndoLater !== 'boolean'))
		)
			throw new Error('Invalid undo options.')
		const client = session.client
		const runtimeId = session.runtimeSessionId
		const result = await client.request('namzu/turns/undo-preview', {
			sessionId: runtimeId,
			turnId,
			...(options?.alsoUndoLater ? { alsoUndoLater: true } : {}),
		})
		if (
			this.closing ||
			this.conversations.get(sessionId) !== session ||
			session.client !== client ||
			session.runtimeSessionId !== runtimeId
		)
			throw new Error('The connection changed while planning the undo. Try again.')
		const preview = readUndoPreview(result)
		if (!preview) throw new Error('Namzu returned an invalid undo plan.')
		return preview
	}
	/**
	 * Holds the prompt queue the way a retry does: nothing is admitted while the files are being
	 * written, and nothing starts under it. The CLI refuses again on its own side.
	 */
	async undoTurn(
		sessionId: string,
		turnId: string,
		planToken: string,
		options?: DesktopUndoOptions,
	): Promise<DesktopUndoResult> {
		const session = this.session(sessionId)
		if (session.running || session.admitting || this.changingPlugins.has(sessionId))
			throw new Error('Wait for this conversation’s active work to finish.')
		if (!session.client.supportsTurnUndo()) throw new Error('Update Namzu to undo a reply.')
		this.assertPalAdmission(session.view.palId, true)
		if (
			typeof turnId !== 'string' ||
			!turnId ||
			turnId.length > 200 ||
			typeof planToken !== 'string' ||
			!planToken ||
			planToken.length > 200
		)
			throw new Error('Invalid undo request.')
		if (
			options !== undefined &&
			(!options ||
				typeof options !== 'object' ||
				Array.isArray(options) ||
				Object.keys(options).some((key) => key !== 'resolutions' && key !== 'alsoUndoLater') ||
				(options.alsoUndoLater !== undefined && typeof options.alsoUndoLater !== 'boolean') ||
				(options.resolutions !== undefined &&
					(!options.resolutions ||
						typeof options.resolutions !== 'object' ||
						Array.isArray(options.resolutions) ||
						Object.entries(options.resolutions).some(
							([path, choice]) => !path || (choice !== 'skip' && choice !== 'keep_copy'),
						))))
		)
			throw new Error('Invalid undo options.')
		const admission = Symbol('undo admission')
		const selectionRevision = session.selectionRevision ?? 0
		session.admitting = admission
		try {
			const client = session.client
			const runtimeId = session.runtimeSessionId
			const assertCurrent = this.metadataRead(this.project(session.view.projectId), session)
			if (
				session.admitting !== admission ||
				(session.selectionRevision ?? 0) !== selectionRevision ||
				this.changingPlugins.has(sessionId)
			)
				throw new Error('This conversation’s settings changed during undo admission.')
			const resolutions = options?.resolutions
				? Object.fromEntries(Object.entries(options.resolutions))
				: undefined
			let result: unknown
			try {
				result = await client.request('namzu/turns/undo', {
					sessionId: runtimeId,
					turnId,
					planToken,
					...(resolutions ? { resolutions } : {}),
					...(options?.alsoUndoLater ? { alsoUndoLater: true } : {}),
				})
			} catch (failure) {
				// A write that failed midway may still have changed files; the card must say so.
				await this.refreshUndoQuietly(session)
				throw failure
			}
			const undone = readUndoResult(result)
			if (!undone) throw new Error('Namzu returned an invalid undo result.')
			// The files changed whether or not the conversation did meanwhile; the status read
			// below checks the connection itself.
			try {
				assertCurrent()
			} catch {
				return undone
			}
			if (undone.status !== 'plan-changed') {
				const ids = [undone.turnId, ...Object.keys(undone.later ?? {})]
				let refreshed = false
				try {
					await this.refreshUndo(session)
					refreshed = true
				} catch {
					/* The result still tells the card what happened. */
				}
				const at = Date.now()
				const current = session.projection.undo
				const stamped = ids.flatMap((id) => {
					const row = current?.[id]
					// When the status read failed, the result itself says what became of the reply.
					const settled =
						!refreshed && id === undone.turnId && row && row.status !== undone.status
							? undone.status === 'undone' || undone.status === 'partially_undone'
								? { ...row, status: undone.status }
								: undefined
							: row
					return settled && (settled.status === 'undone' || settled.status === 'partially_undone')
						? [{ ...settled, undoneAt: at }]
						: []
				})
				if (stamped.length)
					this.emit({
						kind: 'undo-status',
						sessionId: session.view.id,
						turns: stamped,
					})
			}
			return undone
		} finally {
			if (session.admitting === admission) session.admitting = undefined
		}
	}
	private async runRetry(
		session: Conversation,
		turnId: string,
		checkpointId: string,
		options?: Omit<DesktopSendOptions, 'attachmentIds'>,
	): Promise<void> {
		this.emit({ kind: 'retry', sessionId: session.view.id, turnId })
		this.state(session)
		try {
			const result = (await session.client.request(
				'namzu/sessions/retry',
				{
					sessionId: session.runtimeSessionId,
					turnId,
					checkpointId,
					...(options ? { options } : {}),
				},
				0,
			)) as AcpSessionPromptResult
			if (!session.projection.stopReason)
				this.emit({
					kind: 'update',
					projectId: session.view.projectId,
					sessionId: session.view.id,
					update: {
						kind: 'turn_ended',
						turnId,
						stopReason: result.stopReason,
						...(result.reason ? { reason: result.reason } : {}),
					},
				})
			if (result.stopReason === 'error' && !session.projection.error)
				this.state(
					session,
					'Namzu could not retry this turn. Your conversation and draft are retained.',
				)
		} catch (error) {
			if (!session.projection.stopReason)
				this.emit({
					kind: 'update',
					projectId: session.view.projectId,
					sessionId: session.view.id,
					update: {
						kind: 'turn_ended',
						turnId,
						stopReason: 'cancelled',
						reason: 'paused',
					},
				})
			this.state(session, error instanceof Error ? error.message : String(error))
		} finally {
			const settlement = Symbol('retry settlement')
			session.admitting = settlement
			session.running = false
			session.permissions.clear()
			this.emit({ kind: 'permission-cleared', sessionId: session.view.id })
			try {
				await this.refreshRetry(session)
			} catch {
				/* Original failure remains visible. */
			}
			await this.readTasksSnapshot(session, true)
			this.state(session)
			if (session.admitting === settlement) session.admitting = undefined
		}
		// Retry resumes only the checkpoint. Authored queue and draft are retained.
	}
	private draftSession(sessionId: string): Conversation {
		const session = this.conversations.get(sessionId)
		if (!session) throw new Error('Open this conversation first.')
		return session
	}
	private draftOwner(ownerId: string): {
		draft: string
		draftSettings?: DraftSettings
	} {
		const projectOwner = projectDraftOwner(ownerId)
		if (!projectOwner) return this.draftSession(ownerId)
		if (!this.projects.has(projectOwner.projectId)) throw new Error('Unknown project.')
		let owner = this.projectDrafts.get(ownerId)
		if (!owner) {
			owner = { draft: '' }
			this.projectDrafts.set(ownerId, owner)
		}
		return owner
	}
	draft(sessionId: string): string {
		return this.draftOwner(sessionId).draft
	}
	/**
	 * Where a conversation that has chosen nothing starts: the model last picked on its engine.
	 * A Pal and a conversation that already started keep their own. A model the engine no longer
	 * lists is dropped silently, and the source's recommendation applies again.
	 */
	private startingChoice(ownerId: string): DraftSettings['choice'] | undefined {
		const projectOwner = projectDraftOwner(ownerId)
		const session = projectOwner ? undefined : this.conversations.get(ownerId)
		if (session?.hasPrompted || session?.view.palId) return undefined
		const project = this.projects.get(projectOwner?.projectId ?? session?.view.projectId ?? '')
		if (!project || project.view.palId) return undefined
		const engine = session?.view.harness ?? 'namzu'
		const last = this.lastModels.get(engine)
		if (!last) return undefined
		const status = session ? session.providers : project.providers
		if (status && !status.available.some((item) => item.id === last.provider)) return undefined
		const stored = this.storedModels(project, session, last.provider)
		if (stored && !stored.entry.rows.models.some((model) => model.id === last.model)) {
			this.lastModels.delete(engine)
			this.persistDesktop(true)
			return undefined
		}
		return { ...last }
	}
	private rememberModel(ownerId: string, choice: NonNullable<DraftSettings['choice']>): void {
		const projectOwner = projectDraftOwner(ownerId)
		const session = projectOwner ? undefined : this.conversations.get(ownerId)
		const project = this.projects.get(projectOwner?.projectId ?? session?.view.projectId ?? '')
		if (!project || project.view.palId || session?.view.palId) return
		this.lastModels.set(session?.view.harness ?? 'namzu', {
			provider: choice.provider,
			model: choice.model,
			...(choice.label !== undefined ? { label: choice.label } : {}),
		})
	}
	draftSettings(ownerId: string): DraftSettings {
		const value = this.draftOwner(ownerId).draftSettings
		const choice = value?.choice ?? this.startingChoice(ownerId)
		return value || choice
			? {
					...(choice ? { choice: { ...choice } } : {}),
					...(value?.options ? { options: { ...value.options } } : {}),
				}
			: {}
	}
	saveDraftSettings(ownerId: string, value: DraftSettings): void {
		const owner = this.draftOwner(ownerId)
		if (
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value) ||
			Object.keys(value).some((key) => key !== 'choice' && key !== 'options')
		)
			throw new Error('Invalid draft settings.')
		const next: DraftSettings = {}
		if (value.choice !== undefined) {
			const choice = value.choice
			if (
				!choice ||
				typeof choice !== 'object' ||
				Array.isArray(choice) ||
				Object.keys(choice).some(
					(key) => !['provider', 'model', 'label', 'preset', 'auto'].includes(key),
				)
			)
				throw new Error('Invalid draft model choice.')
			for (const key of ['provider', 'model'] as const)
				if (typeof choice[key] !== 'string' || !choice[key].trim() || choice[key].length > 400)
					throw new Error('Invalid draft model choice.')
			if (
				choice.label !== undefined &&
				(typeof choice.label !== 'string' || choice.label.length > 400)
			)
				throw new Error('Invalid draft model label.')
			if (choice.preset !== undefined && choice.preset !== 'default')
				throw new Error('Invalid draft model preset.')
			next.choice = {
				provider: choice.provider,
				model: choice.model,
				...(choice.label !== undefined ? { label: choice.label } : {}),
				...(choice.preset !== undefined ? { preset: choice.preset } : {}),
			}
			if (choice.preset === undefined && choice.auto !== true)
				this.rememberModel(ownerId, next.choice)
		}
		if (value.options !== undefined) {
			const options = value.options
			if (
				!options ||
				typeof options !== 'object' ||
				Array.isArray(options) ||
				Object.keys(options).some((key) => key !== 'effort' && key !== 'permissionMode')
			)
				throw new Error('Invalid draft message settings.')
			if (
				options.effort !== undefined &&
				(typeof options.effort !== 'string' ||
					!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
						options.effort,
					))
			)
				throw new Error('Invalid reasoning effort.')
			if (
				options.permissionMode !== undefined &&
				!['prompt', 'accept-edits', 'auto', 'strict', 'plan'].includes(options.permissionMode)
			)
				throw new Error('Invalid permission mode.')
			next.options = {
				...(options.effort !== undefined ? { effort: options.effort } : {}),
				...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
			}
		}
		owner.draftSettings = next
		this.persistDesktop()
	}
	saveDraft(sessionId: string, draft: string): void {
		const session = this.draftOwner(sessionId)
		if (typeof draft !== 'string' || draft.length > 50_000)
			throw new Error('Keep this draft under 50,000 characters.')
		const otherCharacters = [...this.conversations.values(), ...this.projectDrafts.values()].reduce(
			(total, item) => total + (item === session ? 0 : item.draft.length),
			0,
		)
		if (otherCharacters + draft.length > 1_000_000)
			throw new Error('Draft storage is full. Send or clear another draft before writing more.')
		session.draft = draft
		const conversation = this.conversations.get(sessionId)
		if (conversation) conversation.draftRevision = (conversation.draftRevision ?? 0) + 1
		this.persistDesktop()
	}
	private state(
		session: Conversation,
		error?: string,
		restoredDraft?: string,
		clearError?: true,
	): void {
		this.emit({
			kind: 'state',
			sessionId: session.view.id,
			running: session.running,
			liveInputSupported:
				session.running &&
				!session.projection.stopReason &&
				!session.view.palId &&
				(!session.view.harness || session.view.harness === 'namzu') &&
				session.client.supportsLiveInput(),
			queued: session.queue.map((item) => item.prompt),
			queuedItems: session.queue.map((item) => ({
				id: item.id,
				prompt: item.prompt,
				...(item.files.length ? { attachments: item.files.map((file) => ({ ...file.view })) } : {}),
				...item.options,
			})),
			...(error ? { error } : {}),
			...(clearError ? { clearError } : {}),
			...(restoredDraft !== undefined ? { restoredDraft } : {}),
		})
	}
	private startRun(session: Conversation, item: PendingMessage): void {
		session.executionRevision = (session.executionRevision ?? 0) + 1
		session.liveInputs = new Map()
		session.liveInputRetry = undefined
		session.liveInputReadOnNextUpdate = false
		const running = this.run(session, item)
		session.runSettled = running
		const clear = () => {
			if (session.runSettled === running) session.runSettled = undefined
		}
		void running.then(clear, clear)
	}
	private async run(session: Conversation, item: PendingMessage): Promise<void> {
		const { prompt, files, options } = item
		const hadPrompted =
			session.hasPrompted &&
			(!session.view.palId ||
				session.projection.messages.some((message) => message.role === 'user'))
		session.running = true
		if (session.view.title === 'New conversation')
			session.view.title = (prompt.trim() || files.map((file) => file.view.name).join(', ')).slice(
				0,
				80,
			)
		this.emit({
			kind: 'prompt',
			sessionId: session.view.id,
			prompt,
			...(files.length ? { attachments: files.map((file) => ({ ...file.view })) } : {}),
		})
		this.state(session)
		let completed = false
		let failed = false
		let restoredDraft: string | undefined
		let promptedRuntime: { client: RuntimeClient; id: string } | undefined
		try {
			await this.reattach(session)
			await this.readTasksSnapshot(session)
			this.assertPalAdmission(session.view.palId)
			promptedRuntime = {
				client: session.client,
				id: session.runtimeSessionId,
			}
			session.hasPrompted = true
			if (session.view.closedWhileRunning) {
				// A new question settles the old one: the earlier reply is no longer the latest word.
				delete session.view.closedWhileRunning
				this.emit({
					kind: 'conversation-updated',
					sessionId: session.view.id,
					view: { ...session.view },
				})
			}
			const content = [
				prompt,
				...files.map((file) =>
					file.text !== undefined
						? `Attached text file: ${JSON.stringify(file.view.name)}\n${file.text}`
						: `Attached image: ${JSON.stringify(file.view.name)}`,
				),
			]
				.filter(Boolean)
				.join('\n\n')
			const images = files.flatMap((file) => (file.image ? [file.image] : []))
			const result = (await session.client.request(
				'session/prompt',
				{
					sessionId: session.runtimeSessionId,
					prompt: content,
					...(images.length ? { attachments: images } : {}),
					...(options && session.client.supportsPromptOptions() ? { options } : {}),
				},
				0,
			)) as AcpSessionPromptResult
			// Preparation can stop before the runtime emits a terminal update.
			// Admit the response once so a cancelled/paused turn has a stable end.
			if (!session.projection.stopReason)
				this.emit({
					kind: 'update',
					projectId: session.view.projectId,
					sessionId: session.view.id,
					update: {
						kind: 'turn_ended',
						stopReason: result.stopReason,
						...(result.reason ? { reason: result.reason } : {}),
					},
				})
			completed = result.stopReason === 'end_turn'
			failed = result.stopReason === 'error'
			if (result.stopReason === 'error' && !session.projection.error)
				this.state(
					session,
					'Namzu could not finish this turn. Your conversation is retained; check the provider or tool error before retrying.',
				)
		} catch (error) {
			failed = true
			if (!session.projection.stopReason)
				this.emit({
					kind: 'update',
					projectId: session.view.projectId,
					sessionId: session.view.id,
					update: { kind: 'turn_ended', stopReason: 'error' },
				})
			this.state(session, error instanceof Error ? error.message : String(error))
		} finally {
			if (
				!hadPrompted &&
				failed &&
				!this.closing &&
				promptedRuntime &&
				session.client === promptedRuntime.client &&
				session.runtimeSessionId === promptedRuntime.id
			) {
				let unstarted = false
				try {
					const history = (await promptedRuntime.client.request('namzu/conversations/history', {
						sessionId: promptedRuntime.id,
					})) as { messages: ChatMessage[]; partial: boolean }
					unstarted =
						Array.isArray(history.messages) &&
						history.messages.length === 0 &&
						history.partial === false
				} catch (error) {
					// This exact CLI error follows its ownedSession project/published
					// slot gate. A transport, corrupt journal or foreign-scope error
					// provides no evidence that durable history is absent.
					unstarted =
						error instanceof Error &&
						error.message ===
							`Conversation ${promptedRuntime.id} was not found — load conversation history rejected`
				}
				if (
					unstarted &&
					session.client === promptedRuntime.client &&
					session.runtimeSessionId === promptedRuntime.id
				) {
					// Provider/engine preflight can refuse the first prompt before the
					// CLI creates a journal. Save its authored text without replaying it
					// or replacing a newer draft the user wrote while it was running.
					session.hasPrompted = false
					if (!session.draft && (session.draftRevision ?? 0) === item.draftRevision) {
						session.draft = prompt
						restoredDraft = prompt
					}
				}
			}
			for (const file of files) {
				if (completed) this.attachmentFiles.delete(file.view.id)
				else {
					file.draft = true
					file.ownerId = session.view.id
				}
			}
			// Let an admitted current-turn submission finish its exact-scope ACK
			// reconciliation before deciding whether its text was delivered.
			await Promise.allSettled([...(session.liveInputCalls ?? [])])
			let liveStatusUnknown = false
			let liveRestoredDraft: string | undefined
			let finalLiveStatus: LiveInputStatus | undefined
			try {
				finalLiveStatus = await this.refreshLiveInputs(session)
			} catch {
				liveStatusUnknown = true
			}
			for (const receipt of session.liveInputs?.values() ?? []) {
				if (receipt.status === 'delivered') {
					if (session.draft === receipt.prompt && session.draftRevision === receipt.draftRevision) {
						session.draft = ''
						this.persistDesktop()
					}
					continue
				}
				const observed = finalLiveStatus?.inputs.find((item) => item.id === receipt.id)?.status
				if (receipt.unknown && !observed && finalLiveStatus) {
					// Exact retained scope confirms this attempted ID was never admitted.
					this.emit({
						kind: 'live-input',
						sessionId: session.view.id,
						inputId: receipt.id,
						prompt: receipt.prompt,
						status: 'queued',
					})
					continue
				}
				if (receipt.unknown || !finalLiveStatus || !observed) liveStatusUnknown = true
				if (
					(!session.draft || session.draft === receipt.prompt) &&
					session.draftRevision === receipt.draftRevision
				) {
					session.draft = receipt.prompt
					this.persistDesktop()
					liveRestoredDraft = receipt.prompt
					this.emit({
						kind: 'live-input',
						sessionId: session.view.id,
						inputId: receipt.id,
						prompt: receipt.prompt,
						status: 'queued',
					})
					continue
				}
				const predecessors = new Set(receipt.predecessors)
				let insertAt = 0
				for (const [index, queued] of session.queue.entries())
					if (predecessors.has(queued.id)) insertAt = index + 1
				session.queue.splice(insertAt, 0, {
					id: receipt.id,
					prompt: receipt.prompt,
					files: [],
					...(receipt.unknown || !finalLiveStatus || !observed ? { uncertainLiveInput: true } : {}),
					draftRevision: receipt.draftRevision,
					...(receipt.options ? { options: receipt.options } : {}),
				})
				this.emit({
					kind: 'live-input',
					sessionId: session.view.id,
					inputId: receipt.id,
					prompt: receipt.prompt,
					status: 'queued',
				})
			}
			// An unreadable status cannot prove non-delivery; retain the authored
			// queue for review and never start it automatically on this settlement.
			if (liveStatusUnknown) completed = false
			session.liveInputs?.clear()
			const settlement = Symbol('prompt settlement')
			session.admitting = settlement
			session.running = false
			session.permissions.clear()
			this.emit({ kind: 'permission-cleared', sessionId: session.view.id })
			if (session.client.supportsTurnRetry()) {
				try {
					await this.refreshRetry(session)
				} catch {
					/* Original failure remains visible. */
				}
			}
			await this.refreshUndoQuietly(session)
			await this.readTasksSnapshot(session, true)
			this.state(
				session,
				liveStatusUnknown
					? 'A live message may have been delivered. Check the answer before retrying its retained text.'
					: undefined,
				liveRestoredDraft ??
					((session.draftRevision ?? 0) === item.draftRevision && session.draft === restoredDraft
						? restoredDraft
						: undefined),
			)
			if (session.admitting === settlement) {
				// Release and hand off in one synchronous span; new admission cannot
				// race the previous run's status read or consume its authored queue.
				session.admitting = undefined
				if (
					completed &&
					!this.closing &&
					(!session.view.palId || !this.changingPals.has(session.view.palId))
				) {
					const next = session.queue[0]?.uncertainLiveInput ? undefined : session.queue.shift()
					if (next) this.startRun(session, next)
				}
			}
		}
	}
	async cancel(sessionId: string): Promise<void> {
		const session = this.session(sessionId)
		await session.client.request('session/cancel', {
			sessionId: session.runtimeSessionId,
		})
	}
	takeQueued(sessionId: string, itemId?: string): string | null {
		const session = this.session(sessionId)
		if (session.draft.length > 0 || this.attachments(sessionId).length > 0)
			throw new Error('Send or clear your current draft before editing a queued message.')
		const index =
			itemId === undefined
				? session.queue.length - 1
				: session.queue.findIndex((item) => item.id === itemId)
		if (index < 0) {
			if (itemId !== undefined) throw new Error('This message has already started or was removed.')
			return null
		}
		const prompt = session.queue[index]?.prompt ?? null
		if (prompt !== null) this.saveDraft(sessionId, prompt)
		this.saveDraftSettings(sessionId, {
			...this.draftSettings(sessionId),
			options: resolveComposerSendOptions(session.queue[index]?.options, session.view.palId),
		})
		for (const file of session.queue[index]?.files ?? []) {
			file.draft = true
			file.ownerId = sessionId
		}
		session.queue.splice(index, 1)
		this.state(session)
		return prompt
	}
	removeQueued(sessionId: string, itemId: string): void {
		const session = this.session(sessionId)
		const index = session.queue.findIndex((item) => item.id === itemId)
		if (index < 0) throw new Error('This message has already started or was removed.')
		for (const file of session.queue[index]?.files ?? []) this.attachmentFiles.delete(file.view.id)
		session.queue.splice(index, 1)
		this.state(session)
	}
	respondPermission(sessionId: string, requestId: string, response: PermissionResponse): void {
		const session = this.session(sessionId)
		this.assertPalAdmission(session.view.palId, true)
		const answer = readPermissionResponse(response)
		const wireId = session.permissions.get(requestId)
		if (wireId === undefined || !session.running)
			throw new Error('This approval is no longer pending.')
		session.permissions.delete(requestId)
		// A No from the window is the person's, so the agent records the call as
		// declined by them; the refusals this host makes itself do not say so.
		session.client.answer(
			wireId,
			answer.outcome === 'reject'
				? {
						outcome: 'reject',
						...(answer.feedback ? { feedback: answer.feedback } : {}),
						declined: answer.note ? { note: answer.note } : {},
					}
				: answer,
		)
		this.emit({ kind: 'permission-cleared', sessionId, requestId })
	}
	private onFrame(project: Project, frame: Record<string, unknown>): void {
		if (frame.method === 'namzu/tasks/update' && project.client.supportsTasks()) {
			const params = readTaskUpdate(frame.params)
			if (!params) {
				try {
					this.diagnostics?.record('cli_notice', {
						operation: 'namzu/tasks/update',
						error: new Error('Invalid task update.'),
					})
				} catch {
					/* An invalid notification and its diagnostics grant no UI ownership. */
				}
				return
			}
			const session = params ? this.runtimeSession(project, params.sessionId) : undefined
			if (
				session?.running &&
				(!session.view.harness || session.view.harness === 'namzu') &&
				params
			) {
				session.taskRevision = (session.taskRevision ?? 0) + 1
				this.emit({
					kind: 'task',
					sessionId: session.view.id,
					task: params.task,
					...(params.deleted ? { deleted: true } : {}),
				})
			}
		} else if (frame.method === 'session/update') {
			const params = frame.params as AcpSessionUpdateNotification
			const session = this.runtimeSession(project, params?.sessionId)
			if (session?.view.projectId === project.view.id && session.running) {
				this.emit({
					kind: 'update',
					projectId: project.view.id,
					sessionId: session.view.id,
					update: params.update,
				})
				if (
					session.liveInputs?.size &&
					[...session.liveInputs.values()].some((item) => item.status === 'pending') &&
					((session.liveInputReadOnNextUpdate && params.update?.kind === 'agent_message_chunk') ||
						(params.update?.kind === 'tool_call' && params.update.status !== 'pending') ||
						params.update?.kind === 'turn_ended')
				) {
					session.liveInputReadOnNextUpdate = false
					void this.refreshLiveInputs(session).catch(() => {})
				}
				if (
					(params.update?.kind === 'tool_call' && params.update.status !== 'pending') ||
					params.update?.kind === 'turn_ended'
				)
					this.trackBackgroundWork(session.view.id)
			}
		} else if (
			frame.method === 'session/request_permission' &&
			(typeof frame.id === 'string' || typeof frame.id === 'number')
		) {
			const params = frame.params as AcpRequestPermissionParams
			const session = this.runtimeSession(project, params?.sessionId)
			if (
				!session ||
				session.view.projectId !== project.view.id ||
				!session.running ||
				(session.view.palId &&
					(this.changingPals.has(session.view.palId) ||
						this.operatorComputers.has(session.view.palId))) ||
				!Array.isArray(params.toolCalls)
			) {
				project.client.answer(frame.id, { outcome: 'reject' })
				return
			}
			const id = randomUUID()
			session.permissions.set(id, frame.id)
			const request: PermissionView = {
				id,
				sessionId: session.view.id,
				projectId: project.view.id,
				calls: readPermissionCalls(params.toolCalls),
			}
			this.emit({ kind: 'permission', request })
		} else if (
			frame.id !== undefined &&
			(typeof frame.id === 'string' || typeof frame.id === 'number')
		) {
			project.client.answer(frame.id, { outcome: 'reject' })
		}
	}
	/** Explicit read-only Activity refresh; active runs retain their ordered event stream. */
	async refreshTasks(sessionId: string): Promise<void> {
		const session = this.session(sessionId)
		if (session.running || session.admitting || this.changingPlugins.has(sessionId)) return
		await this.readTasksSnapshot(session, true)
	}
	async jobs(sessionId: string): Promise<unknown> {
		const session = this.session(sessionId)
		if (session.projection.messages.length === 0 && !session.running) return []
		return await session.client.request('namzu/jobs/list', {
			sessionId: session.runtimeSessionId,
		})
	}
	async readJob(sessionId: string, jobId: string): Promise<unknown> {
		const session = this.session(sessionId)
		if (typeof jobId !== 'string' || jobId.length > 400) throw new Error('Invalid job.')
		const result = (await session.client.request('namzu/jobs/read', {
			sessionId: session.runtimeSessionId,
			jobId,
		})) as {
			chunk: string
			droppedBytes: number
		}
		return { output: result.chunk, truncated: result.droppedBytes > 0 }
	}
	async stopJob(sessionId: string, jobId: string): Promise<void> {
		const session = this.session(sessionId)
		if (typeof jobId !== 'string' || jobId.length > 400) throw new Error('Invalid job.')
		await session.client.request('namzu/jobs/stop', {
			sessionId: session.runtimeSessionId,
			jobId,
		})
		this.backgroundWork.invalidate(sessionId)
		this.trackBackgroundWork(sessionId)
	}
	/** How many conversations have a reply running or waiting on the person right now. */
	runningReplies(): number {
		let count = 0
		for (const item of this.conversations.values()) if (item.running || item.admitting) count++
		return count
	}
	async close(): Promise<void> {
		this.closing = true
		// Closing ends these replies; the next launch says so instead of a bare "Stopped.".
		for (const item of this.conversations.values())
			if (item.running && !item.view.palId) item.view.closedWhileRunning = true
		this.backgroundWork.close()
		for (const id of this.computerViewers.keys()) this.closePalComputerStream(id)
		const closing = await Promise.allSettled(
			[...this.ownedClients].map((client) => this.closeClient(client)),
		)
		const starting = await Promise.allSettled([
			...this.projectStarting.values(),
			...(this.registryStarting ? [this.registryStarting] : []),
		])
		if (this.ownedClients.size > 0) {
			throw new AggregateError(
				[...closing, ...starting]
					.filter((result) => result.status === 'rejected')
					.map((result) => result.reason),
				'Namzu could not confirm that all runtime processes stopped. Retry closing Namzu.',
			)
		}
		this.registryClient = undefined
		this.persistDesktop()
		this.projects.clear()
		this.conversations.clear()
		this.attachmentFiles.clear()
		this.attachmentPreviews.clear()
		this.projectDrafts.clear()
	}
}
