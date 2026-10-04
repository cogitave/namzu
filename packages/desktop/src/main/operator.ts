import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
	AcpRequestPermissionParams,
	AcpSessionPromptResult,
	AcpSessionUpdateNotification,
} from '@namzu/sdk'
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
	HarnessView,
	JobView,
	ModelCatalogueView,
	PalChanges,
	PalComputerInput,
	PalComputerStreamView,
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
import { isNormalChatWorkspace, normalChatWorkspace } from './normal-chat-workspace.js'
import type { PalStreamProxy } from './pal-stream-proxy.js'
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
	/** A published replacement slot may need selection retry before it is ready. */
	replacement?: { client: RuntimeClient; id: string }
	/** Actual successful runtime choice, independent of unsubmitted composer settings. */
	providerSelection?: { provider: string; model?: string }
	providerSetupFailure?: string
	selectionRevision?: number
	selectionPending?: boolean
	client: RuntimeClient
	running: boolean
	runSettled?: Promise<void>
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
		private readonly streamProxy?: Pick<PalStreamProxy, 'onClosed' | 'open' | 'close'>,
	) {
		streamProxy?.onClosed((id) => this.closePalComputerStream(id))
	}
	private async closeClient(client: RuntimeClient): Promise<void> {
		for (const [id, viewer] of this.computerViewers)
			if (viewer.client === client) this.closePalComputerStream(id)
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
		const { project } = await this.openPal(id)
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
	async startPalComputer(id: string): Promise<PalComputerView> {
		if (this.changingPals.has(id)) throw new Error('Wait for this Pal’s changes to finish.')
		const epoch = this.computerAuthorityEpochs.get(id) ?? 0
		const { project } = await this.openPal(id)
		if (this.changingPals.has(id) || epoch !== (this.computerAuthorityEpochs.get(id) ?? 0))
			throw new Error('This Pal computer changed before it could start. Refresh its status.')
		return this.startOwnedPalComputer(id, this.project(project.id).client)
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
					item.view.palId === id && (item.running || item.queue.length || item.permissions.size),
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
		if (state.status === 'stopped') {
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
			const { project } = await this.openPal(id)
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
			const { pal, project } = await this.openPal(id)
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
		if (event.kind !== 'connection') {
			const id = event.kind === 'permission' ? event.request.sessionId : event.sessionId
			const session = this.conversations.get(id)
			if (session) {
				const versioned = {
					...event,
					...((event.kind === 'prompt' ||
						(event.kind === 'update' && event.update.kind === 'turn_ended')) &&
					event.at === undefined
						? { at: Date.now() }
						: {}),
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
		const isChat = await isNormalChatWorkspace(cwd, this.registryDirectory)
		const view: ProjectView = {
			id: existing?.view.id ?? randomUUID(),
			path: cwd,
			name: isChat ? 'Chat' : basename(cwd),
			...(isChat ? { isChat: true } : {}),
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
			harness?: ConversationView['harness']
		}[]
		if (!Array.isArray(rows)) throw new Error('Namzu returned an invalid conversation list.')
		const views = rows.map((row) => ({
			id: this.runtimeSession(project, row.id)?.view.id ?? row.id,
			title: row.title,
			updatedAt: row.updatedAt,
			projectId: id,
			...(row.harness
				? { harness: row.harness }
				: this.runtimeSession(project, row.id)?.view.harness
					? { harness: this.runtimeSession(project, row.id)?.view.harness }
					: {}),
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
	async harnesses(projectId: string, sessionId?: string): Promise<HarnessView> {
		const project = this.project(projectId)
		if (!project.view.trusted) throw new Error('Trust this folder first.')
		const session = sessionId ? this.session(sessionId) : undefined
		if (session && session.view.projectId !== projectId)
			throw new Error('This conversation belongs to another project.')
		if (session?.needsLoad) await this.openConversation(projectId, sessionId as string)
		const assertCurrent = this.metadataRead(project, session)
		const view = (await project.client.request(
			'namzu/harnesses/list',
			session ? { sessionId: session.runtimeSessionId } : {},
		)) as HarnessView
		assertCurrent()
		if (session) session.view.harness = view.selected
		return view
	}
	async selectHarness(sessionId: string, engine: HarnessView['selected']): Promise<HarnessView> {
		const session = this.session(sessionId)
		if (session.view.palId)
			throw new Error('External engines are available in normal conversations only.')
		if (!['namzu', 'codex-cli', 'claude-code'].includes(engine))
			throw new Error('Unknown execution engine.')
		if (session.running || session.queue.length || this.changingPlugins.has(sessionId))
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
				(session &&
					(session.client !== client ||
						session.runtimeSessionId !== runtimeId ||
						(session.selectionRevision ?? 0) !== revision ||
						Boolean(session.selectionPending) !== selecting))
			)
				throw new Error('The conversation settings changed while loading. Retry this request.')
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
	private async reattach(
		session: Conversation,
		requested?: { engine: HarnessView['selected']; model?: string },
	): Promise<void> {
		if (!session.needsLoad) return
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
					? { provider: requested.engine, model: requested.model }
					: undefined
				: draftChoice?.provider !== undefined && draftChoice.provider === engine
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
						session.providerSelection = { provider: choice.provider, model: choice.model }
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
				} else if (requested) {
					const restored = (await client.request('namzu/harnesses/select', {
						sessionId: session.runtimeSessionId,
						engine: requested.engine,
					})) as HarnessView
					stillOwned()
					if (restored.selected !== requested.engine)
						throw new Error('The selected engine could not be restored. Your draft is retained.')
					session.view.harness = requested.engine
				}
			}
			stillOwned()
			session.needsLoad = false
			session.replacement = undefined
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
		return result
	}
	async models(id: string, provider: string, sessionId?: string): Promise<ModelCatalogueView> {
		const project = this.project(id)
		if (typeof provider !== 'string' || !provider.trim() || provider.length > 400)
			throw new Error('Invalid provider.')
		const session = sessionId === undefined ? undefined : this.session(sessionId)
		if (session && session.view.projectId !== id)
			throw new Error('This conversation belongs to another project.')
		if (session?.needsLoad) await this.reattach(session)
		const assertCurrent = this.metadataRead(project, session)
		const result = (await project.client.request('namzu/providers/models', {
			provider,
			...(session ? { sessionId: session.runtimeSessionId } : {}),
		})) as ModelCatalogueView
		assertCurrent()
		return result
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
		if (
			typeof provider !== 'string' ||
			provider.length > 400 ||
			(model !== undefined && (typeof model !== 'string' || model.length > 400))
		)
			throw new Error('Invalid model choice.')
		if (session.running || this.changingPlugins.has(sessionId))
			throw new Error('Stop this conversation before changing its model.')
		this.changingPlugins.add(sessionId)
		session.selectionRevision = (session.selectionRevision ?? 0) + 1
		session.selectionPending = true
		try {
			if (session.needsLoad)
				await this.reattach(
					session,
					provider === session.view.harness && provider !== 'namzu'
						? { engine: provider, ...(model?.trim() ? { model: model.trim() } : {}) }
						: undefined,
				)
			const assertCurrent = this.metadataRead(this.project(session.view.projectId), session, true)
			await session.client.request('namzu/providers/select', {
				sessionId: session.runtimeSessionId,
				provider,
				...(model?.trim() ? { model: model.trim() } : {}),
			})
			assertCurrent()
			session.providerSelection = {
				provider,
				...(model?.trim() ? { model: model.trim() } : {}),
			}
			session.providerSetupFailure = undefined
		} finally {
			session.selectionPending = false
			this.changingPlugins.delete(sessionId)
		}
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
		if (this.operatorComputers.has(palId))
			throw new Error('Return this Pal computer’s control before sending a message.')
		if (this.palRecords.get(palId)?.paused)
			throw new Error('Resume this Pal before sending a message.')
	}
	send(sessionId: string, prompt: string, options?: DesktopSendOptions): void {
		const session = this.session(sessionId)
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
		this.startRun(session, captured)
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
	private startRun(session: Conversation, item: PendingMessage): void {
		const running = this.run(session, item)
		session.runSettled = running
		const clear = () => {
			if (session.runSettled === running) session.runSettled = undefined
		}
		void running.then(clear, clear)
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
			this.assertPalAdmission(session.view.palId)
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
			if (result.stopReason === 'error' && !session.projection.error)
				this.state(
					session,
					'Namzu could not finish this turn. Your conversation is retained; check the provider or tool error before retrying.',
				)
		} catch (error) {
			if (!session.projection.stopReason)
				this.emit({
					kind: 'update',
					projectId: session.view.projectId,
					sessionId: session.view.id,
					update: { kind: 'turn_ended', stopReason: 'error' },
				})
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
		if (
			completed &&
			(!session.view.palId ||
				(!this.changingPals.has(session.view.palId) &&
					!this.operatorComputers.has(session.view.palId)))
		) {
			const next = session.queue.shift()
			if (next) this.startRun(session, next)
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
		this.assertPalAdmission(session.view.palId)
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
		this.projects.clear()
		this.conversations.clear()
		this.attachmentFiles.clear()
		this.projectDrafts.clear()
	}
}
