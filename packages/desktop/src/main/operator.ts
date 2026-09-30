import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AcpRequestPermissionParams, AcpSessionUpdateNotification } from '@namzu/sdk'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import type {
	ChatMessage,
	ConversationView,
	DesktopEvent,
	PermissionView,
	ProjectView,
	ProviderView,
} from '../shared/protocol.js'
import { RuntimeClient, type RuntimeCommand } from './rpc-client.js'

interface Project {
	view: ProjectView
	client: RuntimeClient
}
interface Conversation {
	view: ConversationView
	client: RuntimeClient
	running: boolean
	queue: string[]
	projection: ThreadState
	needsLoad?: boolean
	permissions: Map<string, string | number>
}
export class Operator {
	private readonly projects = new Map<string, Project>()
	private readonly conversations = new Map<string, Conversation>()
	constructor(
		private readonly command: RuntimeCommand,
		private readonly publish: (event: DesktopEvent) => void,
	) {}
	private emit(event: DesktopEvent): void {
		if (event.kind !== 'connection') {
			const id = event.kind === 'permission' ? event.request.sessionId : event.sessionId
			const session = this.conversations.get(id)
			if (session) session.projection = applyEvent(session.projection, event)
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
		const project = this.project(id)
		if (!project.view.trusted) return []
		const rows = (await project.client.request('namzu/conversations/list')) as {
			id: string
			title: string
			updatedAt: string
		}[]
		if (!Array.isArray(rows)) throw new Error('Namzu returned an invalid conversation list.')
		const views = rows.map((row) => ({
			id: row.id,
			title: row.title,
			updatedAt: row.updatedAt,
			projectId: id,
		}))
		const returned = new Set(views.map((row) => row.id))
		for (const session of this.conversations.values()) {
			if (session.view.projectId !== id || returned.has(session.view.id)) continue
			if (!session.needsLoad || session.running || session.queue.length)
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
			client: project.client,
			running: false,
			queue: [],
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
		const project = this.project(projectId)
		const existing = this.conversations.get(sessionId)
		if (existing && existing.view.projectId !== projectId)
			throw new Error('This conversation belongs to another project.')
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
				client: project.client,
				running: false,
				queue: [],
				projection: emptyThread(),
				permissions: new Map(),
			})
		}
		if (existing?.needsLoad) {
			await project.client.request('session/load', {
				sessionId,
				cwd: project.view.path,
			})
			existing.needsLoad = false
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
		if (record) record.projection = { ...record.projection, ...history }
		return { ...history, thread: record?.projection }
	}
	async reconnect(id: string): Promise<ProjectView> {
		const project = this.projects.get(id)
		if (!project) throw new Error('Unknown project.')
		if (project.view.status !== 'error') return { ...project.view }
		return this.openProject(project.view.path)
	}
	async providers(id: string, sessionId?: string): Promise<ProviderView> {
		if (sessionId && this.session(sessionId).view.projectId !== id)
			throw new Error('This conversation belongs to another project.')
		return (await this.project(id).client.request(
			'namzu/providers/status',
			sessionId ? { sessionId } : {},
		)) as ProviderView
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
			sessionId,
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
			session.queue.push(prompt)
			this.state(session)
			return
		}
		void this.run(session, prompt)
	}
	private state(session: Conversation, error?: string): void {
		this.emit({
			kind: 'state',
			sessionId: session.view.id,
			running: session.running,
			queued: [...session.queue],
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
			const result = (await session.client.request(
				'session/prompt',
				{ sessionId: session.view.id, prompt },
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
			if (next) void this.run(session, next)
		}
	}
	async cancel(sessionId: string): Promise<void> {
		const session = this.session(sessionId)
		await session.client.request('session/cancel', { sessionId })
	}
	takeQueued(sessionId: string): string | null {
		const session = this.session(sessionId)
		const prompt = session.queue.pop() ?? null
		this.state(session)
		return prompt
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
			const session = this.conversations.get(params?.sessionId)
			if (session?.view.projectId === project.view.id && session.running)
				this.emit({
					kind: 'update',
					projectId: project.view.id,
					sessionId: params.sessionId,
					update: params.update,
				})
		} else if (
			frame.method === 'session/request_permission' &&
			(typeof frame.id === 'string' || typeof frame.id === 'number')
		) {
			const params = frame.params as AcpRequestPermissionParams
			const session = this.conversations.get(params?.sessionId)
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
				sessionId: params.sessionId,
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
		return await session.client.request('namzu/jobs/list', { sessionId })
	}
	async readJob(sessionId: string, jobId: string): Promise<unknown> {
		const session = this.session(sessionId)
		if (typeof jobId !== 'string' || jobId.length > 400) throw new Error('Invalid job.')
		const result = (await session.client.request('namzu/jobs/read', {
			sessionId,
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
		await session.client.request('namzu/jobs/stop', { sessionId, jobId })
	}
	async close(): Promise<void> {
		await Promise.allSettled([...this.projects.values()].map((project) => project.client.close()))
		this.projects.clear()
		this.conversations.clear()
	}
}
