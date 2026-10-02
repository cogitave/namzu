import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AcpRequestPermissionParams, AcpSessionUpdateNotification } from '@namzu/sdk'
import { type ThreadState, applyEvent, emptyThread, restoreMessages } from '../shared/projection.js'
import type {
	AttachmentInput,
	AttachmentView,
	ChatMessage,
	ComposerModelSettings,
	ConversationView,
	DesktopEvent,
	DesktopSendOptions,
	DraftSettings,
	JobView,
	ModelCatalogueView,
	PalChanges,
	PalComputerView,
	PalInput,
	PalScreenView,
	PalView,
	PermissionView,
	PluginInventoryView,
	ProjectView,
	ProviderView,
} from '../shared/protocol.js'
import {
	type AdmittedAttachment,
	MAX_ATTACHMENT_COUNT,
	admitAttachment,
	readChosenFile,
	validateAttachmentBatch,
} from './attachments.js'
import type { DesktopDiagnosticSink } from './diagnostics.js'
import { RuntimeClient, type RuntimeCommand } from './rpc-client.js'

interface PendingMessage {
	id: string
	prompt: string
	files: OwnedAttachment[]
	options?: Omit<DesktopSendOptions, 'attachmentIds'>
}
interface OwnedAttachment extends AdmittedAttachment {
	ownerId: string
	draft: boolean
}

interface Project {
	view: ProjectView
	client: RuntimeClient
	providers?: ProviderView
}
interface Conversation {
	view: ConversationView
	/** Stable UI ownership is separate from a replaceable, never-started runtime session. */
	runtimeSessionId: string
	hasPrompted: boolean
	reattaching?: Promise<void>
	client: RuntimeClient
	running: boolean
	queue: PendingMessage[]
	draft: string
	draftSettings?: DraftSettings
	providers?: ProviderView
	projection: ThreadState
	needsLoad?: boolean
	permissions: Map<string, string | number>
}
export class Operator {
	private closing = false
	private registryClient?: RuntimeClient
	private registryStarting?: Promise<RuntimeClient>
	/** Retain shutdown authority even when a disconnected client leaves its UI slot. */
	private readonly ownedClients = new Set<RuntimeClient>()
	private readonly palRecords = new Map<string, PalView>()
	private readonly changingPals = new Set<string>()
	private readonly projects = new Map<string, Project>()
	private readonly projectStarting = new Map<string, Promise<ProjectView>>()
	private readonly conversations = new Map<string, Conversation>()
	private readonly projectDrafts = new Map<
		string,
		{ draft: string; draftSettings?: DraftSettings }
	>()
	private readonly attachmentFiles = new Map<string, OwnedAttachment>()
	private readonly changingPlugins = new Set<string>()
	constructor(
		private readonly command: RuntimeCommand,
		private readonly publish: (event: DesktopEvent) => void,
		private readonly registryDirectory?: string,
		private readonly diagnostics?: DesktopDiagnosticSink,
	) {}
	private async closeClient(client: RuntimeClient): Promise<void> {
		await client.close()
		this.ownedClients.delete(client)
	}
	private async registry(): Promise<RuntimeClient> {
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
				if (!client.supportsPals()) throw new Error('Update Namzu to a version that supports Pals.')
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
		for (const pal of pals) this.palRecords.set(pal.id, pal)
		return pals
	}
	async palProviders(): Promise<ProviderView> {
		return (await (await this.registry()).request('namzu/providers/status')) as ProviderView
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
	async createPal(input: PalInput): Promise<PalView> {
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
	async openPal(id: string): Promise<{
		pal: PalView
		project: ProjectView
		conversations: ConversationView[]
	}> {
		const pal = (await (await this.registry()).request('namzu/pals/get', { id })) as PalView
		this.palRecords.set(pal.id, pal)
		const view = await this.openProject(pal.workspace)
		const project = this.projects.get(view.id)
		if (!project) throw new Error('This Pal could not connect its local workspace.')
		project.view.palId = pal.id
		project.view.name = pal.name
		return {
			pal,
			project: { ...project.view },
			conversations: await this.listConversations(view.id),
		}
	}
	async palComputer(id: string): Promise<PalComputerView> {
		const { project } = await this.openPal(id)
		return (await this.project(project.id).client.request('namzu/pals/computer/status', {
			palId: id,
		})) as PalComputerView
	}
	async startPalComputer(id: string): Promise<PalComputerView> {
		const { project } = await this.openPal(id)
		return (await this.project(project.id).client.request(
			'namzu/pals/computer/start',
			{
				palId: id,
			},
			120_000,
		)) as PalComputerView
	}
	async stopPalComputer(id: string): Promise<PalComputerView> {
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		this.changingPals.add(id)
		try {
			const { project } = await this.openPal(id)
			const owned = [...this.conversations.values()].filter((item) => item.view.palId === id)
			if (owned.some((item) => item.running || item.queue.length || item.permissions.size))
				throw new Error('Stop this Pal’s active work before stopping its computer.')
			for (const item of owned) {
				const jobs = (await this.jobs(item.view.id)) as JobView[]
				if (!Array.isArray(jobs) || jobs.some((job) => job.status === 'running'))
					throw new Error('Stop this Pal’s background work before stopping its computer.')
			}
			return (await this.project(project.id).client.request('namzu/pals/computer/stop', {
				palId: id,
			})) as PalComputerView
		} finally {
			this.changingPals.delete(id)
		}
	}
	async palScreen(id: string): Promise<PalScreenView> {
		const { project } = await this.openPal(id)
		const screen = (await this.project(project.id).client.request('namzu/pals/computer/screen', {
			palId: id,
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
	private emit(event: DesktopEvent): void {
		if (event.kind !== 'connection') {
			const id = event.kind === 'permission' ? event.request.sessionId : event.sessionId
			const session = this.conversations.get(id)
			if (session) {
				const versioned = {
					...event,
					revision: session.projection.revision + 1,
				}
				session.projection = applyEvent(session.projection, versioned)
				this.publish(versioned)
				return
			}
		}
		this.publish(event)
	}
	listProjects(): ProjectView[] {
		return [...this.projects.values()].map(({ view }) => ({ ...view }))
	}
	async openProject(path: string): Promise<ProjectView> {
		if (this.closing) throw new Error('Namzu is closing.')
		const cwd = await realpath(path)
		if (!(await stat(cwd)).isDirectory()) throw new Error('Choose a folder.')
		if (this.closing) throw new Error('Namzu is closing.')
		const pending = this.projectStarting.get(cwd)
		if (pending) return pending
		const operation = this.connectProject(cwd)
		this.projectStarting.set(cwd, operation)
		try {
			return await operation
		} finally {
			if (this.projectStarting.get(cwd) === operation) this.projectStarting.delete(cwd)
		}
	}
	private async connectProject(cwd: string): Promise<ProjectView> {
		const existing = [...this.projects.values()].find(({ view }) => view.path === cwd)
		if (existing?.view.status !== 'error') {
			if (existing) return existing.view
		}
		if (existing) {
			await this.closeClient(existing.client)
			if (this.closing) throw new Error('Namzu is closing.')
			this.projects.delete(existing.view.id)
		}
		const view: ProjectView = {
			id: existing?.view.id ?? randomUUID(),
			path: cwd,
			name: basename(cwd),
			trusted: false,
			status: 'connecting',
		}
		const client = new RuntimeClient(cwd, this.command, this.diagnostics)
		this.ownedClients.add(client)
		const project = { view, client }
		for (const session of this.conversations.values()) {
			if (session.view.projectId !== view.id) continue
			session.client = client
			session.needsLoad = true
		}
		this.projects.set(view.id, project)
		client.on('frame', (frame) => {
			if (!this.closing && this.projects.get(view.id) === project) this.onFrame(project, frame)
		})
		client.on('closed', (error: Error) => {
			if (this.closing || this.projects.get(view.id) !== project) return
			view.status = 'error'
			view.error = error.message
			for (const session of this.conversations.values()) {
				if (session.view.projectId !== view.id) continue
				session.running = false
				session.permissions.clear()
				this.state(session, error.message)
				this.emit({ kind: 'permission-cleared', sessionId: session.view.id })
			}
			this.emit({ kind: 'connection', project: { ...view } })
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
		return { ...view }
	}
	private project(id: unknown): Project {
		if (this.closing) throw new Error('Namzu is closing.')
		if (typeof id !== 'string') throw new Error('Invalid project.')
		const project = this.projects.get(id)
		if (!project || project.view.status !== 'ready')
			throw new Error('Reopen this project to connect Namzu.')
		return project
	}
	private session(id: unknown): Conversation {
		if (typeof id !== 'string') throw new Error('Invalid conversation.')
		const session = this.conversations.get(id)
		if (!session) throw new Error('Open this conversation first.')
		this.project(session.view.projectId)
		return session
	}
	async trust(id: string): Promise<ProjectView> {
		const project = this.project(id)
		await project.client.request('namzu/project/trust', {
			cwd: project.view.path,
			confirmed: true,
		})
		project.view.trusted = true
		return { ...project.view }
	}
	async listConversations(id: string): Promise<ConversationView[]> {
		const known = this.projects.get(id)
		if (known?.view.status === 'error')
			return [...this.conversations.values()]
				.filter((session) => session.view.projectId === id)
				.map((session) => ({ ...session.view }))
		const project = this.project(id)
		if (!project.view.trusted) return []
		const rows = (await project.client.request(
			project.view.palId ? 'namzu/pals/conversations/list' : 'namzu/conversations/list',
			project.view.palId ? { palId: project.view.palId } : {},
		)) as {
			id: string
			title: string
			updatedAt: string
		}[]
		if (!Array.isArray(rows)) throw new Error('Namzu returned an invalid conversation list.')
		const views = rows.map((row) => ({
			id: this.runtimeSession(project, row.id)?.view.id ?? row.id,
			title: row.title,
			updatedAt: row.updatedAt,
			projectId: id,
			...(project.view.palId ? { palId: project.view.palId } : {}),
		}))
		const returned = new Set(views.map((row) => row.id))
		for (const session of this.conversations.values()) {
			if (session.view.projectId !== id || returned.has(session.view.id)) continue
			if (
				!session.needsLoad ||
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
		return views
	}
	async newConversation(projectId: string): Promise<ConversationView> {
		const project = this.project(projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		this.assertPalAdmission(project.view.palId)
		const result = (await project.client.request('session/new', {
			cwd: project.view.path,
		})) as {
			sessionId: string
		}
		if (project.view.palId)
			await project.client.request('namzu/pals/conversations/claim', {
				palId: project.view.palId,
				sessionId: result.sessionId,
			})
		const view: ConversationView = {
			id: result.sessionId,
			title: 'New conversation',
			projectId,
			updatedAt: new Date().toISOString(),
			...(project.view.palId ? { palId: project.view.palId } : {}),
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
		return view
	}
	async openConversation(
		projectId: string,
		sessionId: string,
	): Promise<{
		messages: ChatMessage[]
		partial: boolean
		thread?: ThreadState
	}> {
		const existing = this.conversations.get(sessionId)
		if (existing && existing.view.projectId !== projectId)
			throw new Error('This conversation belongs to another project.')
		if (existing && this.projects.get(projectId)?.view.status === 'error')
			return {
				messages: existing.projection.messages,
				partial: existing.projection.partial ?? false,
				thread: existing.projection,
			}
		const project = this.project(projectId)
		if (!existing) {
			const list = await this.listConversations(projectId)
			const view = list.find((row) => row.id === sessionId)
			if (!view) throw new Error('This conversation is no longer in this project.')
			await project.client.request('session/load', {
				sessionId,
				cwd: project.view.path,
			})
			this.conversations.set(sessionId, {
				view,
				runtimeSessionId: sessionId,
				hasPrompted: true,
				client: project.client,
				running: false,
				queue: [],
				draft: '',
				projection: emptyThread(),
				permissions: new Map(),
			})
		}
		if (existing?.needsLoad) {
			await this.reattach(existing)
		}
		// Active/transient sessions are rendered from their live UI projection.
		if (existing)
			return {
				messages: existing.projection.messages,
				partial: existing.projection.partial ?? false,
				thread: existing.projection,
			}
		const history = (await project.client.request('namzu/conversations/history', {
			sessionId,
		})) as { messages: ChatMessage[]; partial: boolean }
		const record = this.conversations.get(sessionId)
		if (record)
			record.projection = {
				...restoreMessages(record.projection, history.messages),
				partial: history.partial,
			}
		return { ...history, thread: record?.projection }
	}
	private runtimeSession(project: Project, runtimeId: string): Conversation | undefined {
		return [...this.conversations.values()].find(
			(session) =>
				session.view.projectId === project.view.id &&
				session.client === project.client &&
				session.runtimeSessionId === runtimeId,
		)
	}
	private async reattach(session: Conversation): Promise<void> {
		if (!session.needsLoad) return
		if (session.reattaching) return await session.reattaching
		const project = this.project(session.view.projectId)
		const client = session.client
		const operation = (async () => {
			if (session.hasPrompted) {
				await client.request('session/load', {
					sessionId: session.runtimeSessionId,
					cwd: project.view.path,
				})
			} else {
				// A never-started session has no durable CLI history to load. Keep
				// its UI/draft owner and create only its replacement runtime slot.
				const result = (await client.request('session/new', {
					cwd: project.view.path,
				})) as {
					sessionId: string
				}
				if (session.view.palId)
					await client.request('namzu/pals/conversations/claim', {
						palId: session.view.palId,
						sessionId: result.sessionId,
					})
				if (session.client !== client || project.view.status !== 'ready')
					throw new Error('The connection changed while reopening this conversation.')
				if (typeof result.sessionId !== 'string' || !result.sessionId)
					throw new Error('Namzu returned an invalid conversation identity.')
				const owner = this.runtimeSession(project, result.sessionId)
				if (owner && owner !== session)
					throw new Error('Namzu returned an identity owned by another conversation.')
				session.runtimeSessionId = result.sessionId
			}
			if (session.client !== client || project.view.status !== 'ready')
				throw new Error('The connection changed while reopening this conversation.')
			session.needsLoad = false
		})()
		session.reattaching = operation
		try {
			await operation
		} finally {
			if (session.reattaching === operation) session.reattaching = undefined
		}
	}
	async reconnect(id: string): Promise<ProjectView> {
		const project = this.projects.get(id)
		if (!project) throw new Error('Unknown project.')
		if (project.view.status !== 'error') return { ...project.view }
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
		const result = (await project.client.request(
			'namzu/providers/status',
			session ? { sessionId: session.runtimeSessionId } : {},
		)) as ProviderView
		if (session) session.providers = result
		else project.providers = result
		return result
	}
	async models(id: string, provider: string, sessionId?: string): Promise<ModelCatalogueView> {
		const project = this.project(id)
		if (typeof provider !== 'string' || !provider.trim() || provider.length > 400)
			throw new Error('Invalid provider.')
		const session = sessionId === undefined ? undefined : this.session(sessionId)
		if (session && session.view.projectId !== id)
			throw new Error('This conversation belongs to another project.')
		return (await project.client.request('namzu/providers/models', {
			provider,
			...(session ? { sessionId: session.runtimeSessionId } : {}),
		})) as ModelCatalogueView
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
		return (await project.client.request('namzu/providers/settings', {
			provider,
			model,
			...(session ? { sessionId: session.runtimeSessionId } : {}),
		})) as ComposerModelSettings
	}
	async plugins(id: string, sessionId?: string): Promise<PluginInventoryView> {
		const project = this.project(id)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		const session = sessionId === undefined ? undefined : this.session(sessionId)
		if (session && session.view.projectId !== id)
			throw new Error('This conversation belongs to another project.')
		return (await project.client.request(
			'namzu/plugins/list',
			session ? { sessionId: session.runtimeSessionId } : {},
		)) as PluginInventoryView
	}
	async setPluginEnabled(
		sessionId: string,
		name: string,
		enabled: boolean,
	): Promise<PluginInventoryView> {
		const session = this.session(sessionId)
		if (session.running || session.permissions.size || this.changingPlugins.has(sessionId))
			throw new Error('Stop this conversation’s active work before changing plugins.')
		if (
			typeof name !== 'string' ||
			!name.trim() ||
			name.length > 400 ||
			typeof enabled !== 'boolean'
		)
			throw new Error('Invalid plugin choice.')
		this.changingPlugins.add(sessionId)
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
		if (session.needsLoad) await this.openConversation(session.view.projectId, sessionId)
		if (session.running || this.changingPlugins.has(sessionId))
			throw new Error('Stop this conversation before changing its model.')
		if (
			typeof provider !== 'string' ||
			provider.length > 400 ||
			(model !== undefined && (typeof model !== 'string' || model.length > 400))
		)
			throw new Error('Invalid model choice.')
		await session.client.request('namzu/providers/select', {
			sessionId: session.runtimeSessionId,
			provider,
			...(model?.trim() ? { model: model.trim() } : {}),
		})
	}
	private attachmentProject(ownerId: string): string {
		this.draftOwner(ownerId)
		return ownerId.startsWith('project:')
			? ownerId.slice(8)
			: this.draftSession(ownerId).view.projectId
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
		return this.attachments(toSessionId)
	}
	private assertPalAdmission(palId?: string): void {
		if (!palId) return
		if (this.changingPals.has(palId)) throw new Error('Wait for this Pal’s changes to finish.')
		if (this.palRecords.get(palId)?.paused)
			throw new Error('Resume this Pal before sending a message.')
	}
	send(sessionId: string, prompt: string, options?: DesktopSendOptions): void {
		const session = this.session(sessionId)
		this.assertPalAdmission(session.view.palId)
		if (this.changingPlugins.has(sessionId))
			throw new Error('Wait for this conversation’s plugin change to finish.')
		if (
			options !== undefined &&
			(!options || typeof options !== 'object' || Array.isArray(options))
		)
			throw new Error('Invalid message options.')
		const ids = options?.attachmentIds ?? []
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
			...(options
				? {
						options: {
							...(options.effort ? { effort: options.effort } : {}),
							permissionMode: options.permissionMode ?? 'prompt',
						},
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
			if (session.draft === prompt) session.draft = ''
			this.state(session)
			return
		}
		for (const file of files) {
			file.draft = false
			file.ownerId = sessionId
		}
		if (session.draft === prompt) session.draft = ''
		void this.run(session, captured)
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
		if (!ownerId.startsWith('project:')) return this.draftSession(ownerId)
		if (!this.projects.has(ownerId.slice('project:'.length))) throw new Error('Unknown project.')
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
	draftSettings(ownerId: string): DraftSettings {
		const value = this.draftOwner(ownerId).draftSettings
		return value
			? {
					...(value.choice ? { choice: { ...value.choice } } : {}),
					...(value.options ? { options: { ...value.options } } : {}),
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
				Object.keys(choice).some((key) => !['provider', 'model', 'label'].includes(key))
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
			next.choice = {
				provider: choice.provider,
				model: choice.model,
				...(choice.label !== undefined ? { label: choice.label } : {}),
			}
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
	}
	private state(session: Conversation, error?: string): void {
		this.emit({
			kind: 'state',
			sessionId: session.view.id,
			running: session.running,
			queued: session.queue.map((item) => item.prompt),
			queuedItems: session.queue.map((item) => ({
				id: item.id,
				prompt: item.prompt,
				...(item.files.length ? { attachments: item.files.map((file) => ({ ...file.view })) } : {}),
				...item.options,
			})),
			...(error ? { error } : {}),
		})
	}
	private async run(session: Conversation, item: PendingMessage): Promise<void> {
		const { prompt, files, options } = item
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
		try {
			await this.reattach(session)
			session.hasPrompted = true
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
			)) as { stopReason: string }
			completed = result.stopReason === 'end_turn'
			if (result.stopReason === 'error' && !session.projection.error)
				this.state(
					session,
					'Namzu could not finish this turn. Your conversation is retained; check the provider or tool error before retrying.',
				)
		} catch (error) {
			this.state(session, error instanceof Error ? error.message : String(error))
		} finally {
			for (const file of files) {
				if (completed) this.attachmentFiles.delete(file.view.id)
				else {
					file.draft = true
					file.ownerId = session.view.id
				}
			}
			session.running = false
			session.permissions.clear()
			this.emit({ kind: 'permission-cleared', sessionId: session.view.id })
			this.state(session)
		}
		if (completed) {
			const next = session.queue.shift()
			if (next) void this.run(session, next)
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
			options: session.queue[index]?.options ?? { permissionMode: 'prompt' },
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
	approve(sessionId: string, requestId: string, approved: boolean): void {
		const session = this.session(sessionId)
		if (typeof approved !== 'boolean') throw new Error('Invalid approval.')
		const wireId = session.permissions.get(requestId)
		if (wireId === undefined || !session.running)
			throw new Error('This approval is no longer pending.')
		session.permissions.delete(requestId)
		session.client.answer(wireId, { outcome: approved ? 'approve' : 'reject' })
		this.emit({ kind: 'permission-cleared', sessionId, requestId })
	}
	private onFrame(project: Project, frame: Record<string, unknown>): void {
		if (frame.method === 'session/update') {
			const params = frame.params as AcpSessionUpdateNotification
			const session = this.runtimeSession(project, params?.sessionId)
			if (session?.view.projectId === project.view.id && session.running)
				this.emit({
					kind: 'update',
					projectId: project.view.id,
					sessionId: session.view.id,
					update: params.update,
				})
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
				calls: params.toolCalls,
			}
			this.emit({ kind: 'permission', request })
		} else if (
			frame.id !== undefined &&
			(typeof frame.id === 'string' || typeof frame.id === 'number')
		) {
			project.client.answer(frame.id, { outcome: 'reject' })
		}
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
	}
	async close(): Promise<void> {
		this.closing = true
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
		this.projects.clear()
		this.conversations.clear()
		this.attachmentFiles.clear()
		this.projectDrafts.clear()
	}
}
