import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AcpRequestPermissionParams, AcpSessionUpdateNotification } from '@namzu/sdk'
import { type ThreadState, applyEvent, emptyThread, restoreMessages } from '../shared/projection.js'
import type {
	ChatMessage,
	ConversationView,
	DesktopEvent,
	ModelCatalogueView,
	PermissionView,
	ProjectView,
	ProviderView,
	QueuedMessageView,
} from '../shared/protocol.js'
import { RuntimeClient, type RuntimeCommand } from './rpc-client.js'

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
	queue: QueuedMessageView[]
	draft: string
	providers?: ProviderView
	projection: ThreadState
	needsLoad?: boolean
	permissions: Map<string, string | number>
}
export class Operator {
	private readonly projects = new Map<string, Project>()
	private readonly conversations = new Map<string, Conversation>()
	private readonly projectDrafts = new Map<string, { draft: string }>()
	constructor(
		private readonly command: RuntimeCommand,
		private readonly publish: (event: DesktopEvent) => void,
	) {}
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
		const cwd = await realpath(path)
		if (!(await stat(cwd)).isDirectory()) throw new Error('Choose a folder.')
		const existing = [...this.projects.values()].find(({ view }) => view.path === cwd)
		if (existing?.view.status !== 'error') {
			if (existing) return existing.view
		}
		if (existing) {
			await existing.client.close()
			this.projects.delete(existing.view.id)
		}
		const view: ProjectView = {
			id: existing?.view.id ?? randomUUID(),
			path: cwd,
			name: basename(cwd),
			trusted: false,
			status: 'connecting',
		}
		const client = new RuntimeClient(cwd, this.command)
		const project = { view, client }
		for (const session of this.conversations.values()) {
			if (session.view.projectId !== view.id) continue
			session.client = client
			session.needsLoad = true
		}
		this.projects.set(view.id, project)
		client.on('frame', (frame) => this.onFrame(project, frame))
		client.on('closed', (error: Error) => {
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
			const status = (await client.request('namzu/project/status')) as {
				trusted: boolean
			}
			view.trusted = status.trusted === true
			view.status = 'ready'
		} catch (error) {
			view.status = 'error'
			view.error = error instanceof Error ? error.message : String(error)
			client.close()
		}
		this.emit({ kind: 'connection', project: { ...view } })
		return { ...view }
	}
	private project(id: unknown): Project {
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
		const rows = (await project.client.request('namzu/conversations/list')) as {
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
		}))
		const returned = new Set(views.map((row) => row.id))
		for (const session of this.conversations.values()) {
			if (session.view.projectId !== id || returned.has(session.view.id)) continue
			if (!session.needsLoad || session.running || session.queue.length || session.draft.length)
				views.unshift({ ...session.view })
		}
		return views
	}
	async newConversation(projectId: string): Promise<ConversationView> {
		const project = this.project(projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		const result = (await project.client.request('session/new', {
			cwd: project.view.path,
		})) as {
			sessionId: string
		}
		const view: ConversationView = {
			id: result.sessionId,
			title: 'New conversation',
			projectId,
			updatedAt: new Date().toISOString(),
		}
		this.conversations.set(view.id, {
			view,
			runtimeSessionId: view.id,
			hasPrompted: false,
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
	async selectProvider(sessionId: string, provider: string, model?: string): Promise<void> {
		const session = this.session(sessionId)
		if (session.needsLoad) await this.openConversation(session.view.projectId, sessionId)
		if (session.running) throw new Error('Stop this conversation before changing its model.')
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
	send(sessionId: string, prompt: string): void {
		const session = this.session(sessionId)
		if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50_000)
			throw new Error('Enter a message under 50,000 characters.')
		if (session.running) {
			if (session.queue.length >= 20) throw new Error('The message queue is full.')
			session.queue.push({ id: randomUUID(), prompt })
			if (session.draft === prompt) session.draft = ''
			this.state(session)
			return
		}
		if (session.draft === prompt) session.draft = ''
		void this.run(session, prompt)
	}
	private draftSession(sessionId: string): Conversation {
		const session = this.conversations.get(sessionId)
		if (!session) throw new Error('Open this conversation first.')
		return session
	}
	private draftOwner(ownerId: string): { draft: string } {
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
			queuedItems: session.queue.map((item) => ({ ...item })),
			...(error ? { error } : {}),
		})
	}
	private async run(session: Conversation, prompt: string): Promise<void> {
		session.running = true
		if (session.view.title === 'New conversation') session.view.title = prompt.trim().slice(0, 80)
		this.emit({ kind: 'prompt', sessionId: session.view.id, prompt })
		this.state(session)
		let completed = false
		try {
			await this.reattach(session)
			session.hasPrompted = true
			const result = (await session.client.request(
				'session/prompt',
				{ sessionId: session.runtimeSessionId, prompt },
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
			session.running = false
			session.permissions.clear()
			this.emit({ kind: 'permission-cleared', sessionId: session.view.id })
			this.state(session)
		}
		if (completed) {
			const next = session.queue.shift()
			if (next) void this.run(session, next.prompt)
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
		if (session.draft.length > 0)
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
		session.queue.splice(index, 1)
		this.state(session)
		return prompt
	}
	removeQueued(sessionId: string, itemId: string): void {
		const session = this.session(sessionId)
		const index = session.queue.findIndex((item) => item.id === itemId)
		if (index < 0) throw new Error('This message has already started or was removed.')
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
		await Promise.allSettled([...this.projects.values()].map((project) => project.client.close()))
		this.projects.clear()
		this.conversations.clear()
	}
}
