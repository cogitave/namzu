import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
/** External engines own their tools and inference. ACP only hosts their sessions. */
import {
	type AcpAgentGateway,
	type HarnessAdapter,
	type HarnessSession,
	type SessionEvent,
	asSessionId,
	createHarnessSession,
} from '@namzu/sdk'
import {
	createClaudeHarnessAdapter,
	discoverClaudeHarnessModels,
} from '../integrations/harness/claude-adapter.js'
import {
	CodexServerPool,
	type EngineTimings,
	createCodexHarnessAdapter,
	discoverCodexHarnessModels,
} from '../integrations/harness/codex-adapter.js'
import type { HarnessCatalogueModel } from '../integrations/harness/codex-protocol.js'
import {
	type EngineModelCache,
	createEngineModelCache,
} from '../integrations/harness/model-cache.js'
import { resolveHarnessExecutable } from '../integrations/harness/native-executable.js'
import {
	type CliSessionScope,
	type CliSessions,
	closeSessions,
	loadResumableConversation,
	openConversationLog,
	openSessions,
	readConversationFacts,
	refreshIndex,
} from '../integrations/sessions/store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { isTrustedAtStateRoot } from '../integrations/trust/store.js'
import { palAtWorkspace } from '../pals/store.js'
import { canonicalProjectPath } from '../permissions/canonical-project.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import type { CliAcpRuntime } from './acp.js'

export type CliHarnessId = 'namzu' | 'codex-cli' | 'claude-code'
type ExternalEngine = Exclude<CliHarnessId, 'namzu'>
/** `model` is unknown until the engine's list has been read, unless the person chose one. */
type Selection = { engine: ExternalEngine; model?: string }
export interface CliHarnessView {
	selected: CliHarnessId
	locked: boolean
	engines: {
		id: CliHarnessId
		label: string
		available: boolean
		notice?: string
	}[]
	/** What engine starts cost since the last report; the host drains them. */
	timings?: CliEngineTiming[]
}
/** What one engine start cost, tagged with the engine and the step that waited for it. */
export interface CliEngineTiming {
	engine: ExternalEngine
	operation: 'open' | 'models'
	timings: EngineTimings
}
export interface CliHarnessDependencies {
	adapter(engine: ExternalEngine): Promise<HarnessAdapter>
	models(engine: ExternalEngine, cwd: string): Promise<readonly HarnessCatalogueModel[]>
	installed(engine: ExternalEngine): Promise<boolean>
	/**
	 * Names the installed build of an engine (its executable's path, size and modification time),
	 * so a cached model list never outlives an upgrade. Without it nothing is keyed by build.
	 */
	identity?(engine: ExternalEngine): Promise<string | undefined>
	/** Drains what engine starts cost since the last call. */
	timings?(): CliEngineTiming[]
	/** The last run's model list for an installed build, so a start does not wait for the engine. */
	cache?: EngineModelCache
	/** Ends every engine server these dependencies started. */
	close?(): Promise<void>
	/** Ends the idle servers kept for one engine, so its program can be replaced on disk. */
	release?(engine: ExternalEngine): Promise<void>
	now?: () => number
	openSessions?: typeof openSessions
	decideTrust?: typeof decideHeadlessTrust
	isPal?: (cwd: string) => boolean
}
/** A model list read this recently is served as it is; an older one is read again. */
export const MODEL_LIST_FRESH_MS = 10 * 60 * 1000
function createDefaults(): CliHarnessDependencies {
	const pool = new CodexServerPool()
	const timings: CliEngineTiming[] = []
	const note = (engine: ExternalEngine, operation: CliEngineTiming['operation']) => {
		return (value: EngineTimings) => {
			timings.push({ engine, operation, timings: value })
			if (timings.length > 16) timings.shift()
		}
	}
	return {
		adapter: async (engine) => {
			if (engine === 'codex-cli') {
				const report = note(engine, 'open')
				return createCodexHarnessAdapter({ pool, onTiming: (_, value) => report(value) })
			}
			const executable = await resolveHarnessExecutable('claude')
			const stateHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
			if (!isAbsolute(stateHome))
				throw new Error(
					'CLAUDE_CONFIG_DIR must be an absolute directory for native engine sessions.',
				)
			return createClaudeHarnessAdapter({
				executable,
				profileRef: `claude:${createHash('sha256').update(`${executable}\0${stateHome}`).digest('hex')}`,
			})
		},
		models: async (engine, cwd) => {
			const report = note(engine, 'models')
			if (engine === 'codex-cli')
				return discoverCodexHarnessModels({ cwd, pool, onTiming: (_, value) => report(value) })
			const began = performance.now()
			const rows = await discoverClaudeHarnessModels({ cwd })
			report({ totalMs: Math.round(performance.now() - began) })
			return rows
		},
		installed: async (engine) => {
			try {
				await resolveHarnessExecutable(engine === 'codex-cli' ? 'codex' : 'claude')
				return true
			} catch {
				return false
			}
		},
		identity: async (engine) => {
			try {
				const executable = await resolveHarnessExecutable(
					engine === 'codex-cli' ? 'codex' : 'claude',
				)
				const file = await stat(executable)
				return createHash('sha256')
					.update(JSON.stringify([executable, file.size, Math.round(file.mtimeMs)]))
					.digest('hex')
					.slice(0, 16)
			} catch {
				return undefined
			}
		},
		timings: () => timings.splice(0),
		cache: (() => {
			try {
				return createEngineModelCache(join(resolveNamzuHome(), 'engine-models.json'))
			} catch {
				// A home that cannot be resolved only means nothing is kept between runs.
				return undefined
			}
		})(),
		close: () => pool.closeAll(),
		// Only Codex keeps a server between uses; the other engine's discovery is a process that already ended.
		release: (engine) => (engine === 'codex-cli' ? pool.closeAll() : Promise.resolve()),
	}
}
const labels: Record<CliHarnessId, string> = {
	namzu: 'Namzu',
	'codex-cli': 'Codex CLI',
	'claude-code': 'Claude Code',
}
function external(id: string): id is ExternalEngine {
	return id === 'codex-cli' || id === 'claude-code'
}
function engineForBinding(id: string): ExternalEngine | undefined {
	return id === 'codex' ? 'codex-cli' : id === 'claude' ? 'claude-code' : undefined
}

export interface CliHarnessRuntime extends CliAcpRuntime {
	harnesses(sessionId?: string): Promise<CliHarnessView>
	selectHarness(sessionId: string, engine: string): Promise<CliHarnessView>
	/** Ends the idle engine servers this connection keeps, without touching a running conversation. */
	releaseHarness(engine: string): Promise<void>
	/** Release only this connection's idle native writer, reserving it until archive settles. */
	withIdleConversationForArchive?<T>(
		sessionId: string,
		scope: CliSessionScope,
		archive: () => Promise<T>,
	): Promise<T>
}

/** One controller per ACP connection. Native IDs never participate in Namzu lookup. */
export function withCliHarnesses(
	base: CliAcpRuntime,
	directory: string,
	deps: CliHarnessDependencies = createDefaults(),
): CliHarnessRuntime {
	const selections = new Map<string, Selection>()
	const records = new Map<
		string,
		{
			session: HarnessSession
			state: CliSessions
			route?: (event: SessionEvent) => void
			review?: (request: import('@namzu/sdk').HarnessReviewRequest) => void
		}
	>()
	const reserving = new Set<string>()
	// One entry per engine, folder and installed build; an upgrade is a different key.
	interface Catalogue {
		promise: Promise<readonly HarnessCatalogueModel[]>
		/** The newest rows known, which a read in flight does not erase. */
		models?: readonly HarnessCatalogueModel[]
		at?: number
		/** No read of this entry is in flight. */
		settled: boolean
		/** The rows came from the last run's file and this run has not read the engine yet. */
		stored?: boolean
	}
	const catalogues = new Map<string, Catalogue>()
	const clock = () => (deps.now ?? Date.now)()
	let closed = false
	const trusted = (requested = directory, stateRoot?: string) => {
		if (closed) throw new Error('The connection is closed.')
		const trust = (deps.decideTrust ?? decideHeadlessTrust)({
			cwd: requested,
			trustFlag: false,
			...(stateRoot ? { trusted: (path: string) => isTrustedAtStateRoot(path, stateRoot) } : {}),
		})
		if (!trust.allowed) throw new Error(trust.message ?? 'Trust this folder first.')
		const cwd = canonicalProjectPath(trust.cwd)
		if ((deps.isPal ?? ((path) => Boolean(palAtWorkspace(path, stateRoot))))(cwd))
			throw new Error('External engines are available in normal conversations only.')
		return cwd
	}
	const stateFor = (cwd: string) => (deps.openSessions ?? openSessions)(cwd)
	const facts = async (id: string, cwd: string) => {
		const state = await stateFor(cwd)
		try {
			const value = await readConversationFacts(state, asSessionId(id))
			if (
				value &&
				(value.started.projectId !== state.projectId || value.started.tenantId !== state.tenantId)
			)
				throw new Error('This conversation does not belong to this project.')
			return value
		} finally {
			closeSessions(state)
		}
	}
	/**
	 * Reading a conversation's facts opens its project's index, which is the slow part of a choice on
	 * a slow disk. A request that needs them more than once reads them once and passes them on.
	 */
	type Loaded = { saved: Awaited<ReturnType<typeof facts>> }
	const selectionFor = async (
		id: string,
		cwd: string,
		loaded?: Loaded,
	): Promise<Selection | undefined> => {
		const saved = loaded ? loaded.saved : await facts(id, cwd)
		if (saved?.started.harness) {
			const binding = saved.started.harness
			const engine = engineForBinding(binding.engineId)
			if (!engine || canonicalProjectPath(binding.cwd) !== cwd)
				throw new Error('This conversation has an unsupported engine or execution directory.')
			const pending = selections.get(id)
			if (pending && pending.engine !== engine)
				throw new Error('The conversation engine cannot change.')
			const latest = [...saved.records]
				.reverse()
				.find(
					(record) =>
						record.type === 'session_updated' &&
						record.harness?.kind === 'dispatch-prepared' &&
						record.harness.model,
				)
			const model =
				latest?.type === 'session_updated' && latest.harness?.kind === 'dispatch-prepared'
					? latest.harness.model
					: undefined
			return pending ?? { engine, model: model ?? binding.initialModel }
		}
		if (saved) {
			if (selections.has(id))
				throw new Error(
					'This conversation is already bound to the Namzu engine. Open a new tab for another engine.',
				)
			return undefined
		}
		return selections.get(id)
	}
	const fresh = (entry: Catalogue | undefined) =>
		entry?.settled === true &&
		entry.stored !== true &&
		entry.at !== undefined &&
		clock() - entry.at < MODEL_LIST_FRESH_MS
	/** This build's entry: the one in memory, else the last run's rows from the file. */
	const lookup = async (engine: ExternalEngine, cwd: string) => {
		const identity = (await deps.identity?.(engine)) ?? ''
		const key = JSON.stringify([engine, cwd, identity])
		// A list read from another build of the same engine is gone as soon as the build changes.
		for (const other of [...catalogues.keys()]) {
			const [otherEngine, otherCwd] = JSON.parse(other) as [string, string, string]
			if (otherEngine === engine && otherCwd === cwd && other !== key) catalogues.delete(other)
		}
		let entry = catalogues.get(key)
		if (!entry && identity && deps.cache) {
			const stored = await deps.cache.read(engine, identity).catch(() => undefined)
			entry = catalogues.get(key)
			if (!entry && stored?.rows.length) {
				entry = {
					promise: Promise.resolve(stored.rows),
					models: stored.rows,
					at: stored.at,
					settled: true,
					stored: true,
				}
				catalogues.set(key, entry)
			}
		}
		return { key, identity, entry }
	}
	const discover = (
		key: string,
		identity: string,
		engine: ExternalEngine,
		cwd: string,
		previous?: Catalogue,
	): Catalogue => {
		// The list being read again still names the default until the new one arrives.
		const entry: Catalogue = {
			promise: Promise.resolve([]),
			settled: false,
			...(previous?.models ? { models: previous.models } : {}),
		}
		entry.promise = deps
			.models(engine, cwd)
			.then((models) => {
				entry.models = models
				entry.at = clock()
				entry.settled = true
				if (identity && models.length)
					void deps.cache?.write(engine, identity, models, entry.at).catch(() => undefined)
				return models
			})
			.catch((error) => {
				if (catalogues.get(key) === entry) catalogues.delete(key)
				throw error
			})
		catalogues.set(key, entry)
		return entry
	}
	/**
	 * The engine's models. `cached` answers from memory or the last run's file and reads the engine
	 * only when nothing is known; `revalidate` reads again once a list is older than
	 * MODEL_LIST_FRESH_MS (or came from the file); `force` always reads. A read in flight is shared,
	 * and reading goes through a server that opening the conversation takes over, so it is not a
	 * spawn of its own.
	 */
	const modelsFor = async (
		engine: ExternalEngine,
		cwd: string,
		mode: 'cached' | 'revalidate' | 'force' = 'cached',
	) => {
		const { key, identity, entry } = await lookup(engine, cwd)
		const again =
			entry?.settled === true && (mode === 'force' || (mode === 'revalidate' && !fresh(entry)))
		const found = entry && !again ? entry : discover(key, identity, engine, cwd, entry)
		const models = await found.promise
		if (!models.length && catalogues.get(key) === found) catalogues.delete(key)
		if (!models.length)
			throw new Error(
				'This engine returned no available models. Check its local sign-in and version.',
			)
		return models
	}
	/** The rows already known for this engine's build, if any; never starts a read. */
	const knownModels = async (engine: ExternalEngine, cwd: string) =>
		(await lookup(engine, cwd)).entry?.models
	/**
	 * A model the engine lists. A row missing from a list that is not fresh (last run's file, or an
	 * old read) is looked for once more in a list read now, so a new model is not refused.
	 */
	const findModel = async (engine: ExternalEngine, cwd: string, wanted: string | undefined) => {
		let models = await modelsFor(engine, cwd)
		const target = (list: readonly HarnessCatalogueModel[]) =>
			wanted === undefined
				? (list.find((row) => row.default) ?? list[0])
				: list.find((row) => row.id === wanted)
		let row = target(models)
		if (!row && !fresh((await lookup(engine, cwd)).entry)) {
			models = await modelsFor(engine, cwd, 'force')
			row = target(models)
		}
		return { row, models }
	}
	const defaultModel = (models: readonly HarnessCatalogueModel[]) =>
		(models.find((row) => row.default) ?? models[0])?.id
	const view = async (id?: string, preloaded?: Loaded): Promise<CliHarnessView> => {
		const cwd = trusted()
		const loaded = id ? (preloaded ?? { saved: await facts(id, cwd) }) : undefined
		const selected = id ? await selectionFor(id, cwd, loaded) : undefined
		const saved = loaded?.saved ?? null
		const engines = await Promise.all(
			(['namzu', 'codex-cli', 'claude-code'] as const).map(async (engine) => ({
				id: engine,
				label: labels[engine],
				available: engine === 'namzu' || (await deps.installed(engine)),
			})),
		)
		const timings = deps.timings?.() ?? []
		return {
			selected: selected?.engine ?? 'namzu',
			locked: Boolean(saved),
			engines,
			...(timings.length ? { timings } : {}),
		}
	}
	const gateway: AcpAgentGateway = {
		...base.gateway,
		load: async (id, requestedCwd) => {
			if (!requestedCwd) throw new Error('A project is required to load a conversation.')
			// Pal conversations remain on their existing admission path.
			if ((deps.isPal ?? ((path) => Boolean(palAtWorkspace(path))))(requestedCwd))
				return base.gateway.load?.(id, requestedCwd)
			const cwd = trusted(requestedCwd)
			if (!(await selectionFor(id, cwd))) return base.gateway.load?.(id, cwd)
			const state = await stateFor(cwd)
			try {
				return await loadResumableConversation(state, asSessionId(id))
			} finally {
				closeSessions(state)
			}
		},
		prompt: async (request) => {
			if ((deps.isPal ?? ((path) => Boolean(palAtWorkspace(path))))(request.cwd))
				return base.gateway.prompt(request)
			const cwd = trusted(request.cwd)
			if (reserving.has(request.sessionId))
				throw new Error('This conversation is already connecting.')
			reserving.add(request.sessionId)
			let record = records.get(request.sessionId)
			try {
				const choice = await selectionFor(request.sessionId, cwd)
				if (!choice) return await base.gateway.prompt(request)
				if (request.attachments?.length)
					throw new Error(
						'This engine connection does not support attachments yet. Your draft is retained.',
					)
				request.signal.throwIfAborted()
				const { row: model } = await findModel(choice.engine, cwd, choice.model)
				if (!model) throw new Error('Choose a model listed by this engine.')
				const mode = request.options?.permissionMode ?? 'prompt'
				const supportedReviewModes =
					choice.engine === 'codex-cli'
						? ['prompt', 'plan', 'accept-edits', 'auto', 'strict']
						: ['prompt', 'plan']
				if (!supportedReviewModes.includes(mode))
					throw new Error(
						choice.engine === 'claude-code'
							? 'This engine supports Ask first and Plan only.'
							: 'This engine does not support the selected permission mode.',
					)
				if (request.options?.effort && !model.effortLevels?.includes(request.options.effort))
					throw new Error('This engine model does not support the selected effort.')
				if (!record) {
					const state = await stateFor(cwd)
					try {
						const adapter = await deps.adapter(choice.engine)
						const owner = {
							state,
							session: undefined as unknown as HarnessSession,
							route: undefined as ((event: SessionEvent) => void) | undefined,
							review: undefined as
								| ((review: import('@namzu/sdk').HarnessReviewRequest) => void)
								| undefined,
						}
						owner.session = createHarnessSession({
							scope: {
								sessionId: asSessionId(request.sessionId),
								projectId: state.projectId,
								topicId: state.topicId,
								tenantId: state.tenantId,
								cwd,
							},
							sessionLog: openConversationLog(state, asSessionId(request.sessionId)),
							adapter,
							assertAdmission: async (admission, signal) => {
								signal?.throwIfAborted()
								if (trusted(cwd) !== admission.scope.cwd)
									throw new Error('The execution directory changed.')
								const durable = await readConversationFacts(state, asSessionId(request.sessionId))
								if (
									durable &&
									(!durable.started.harness ||
										durable.started.projectId !== state.projectId ||
										durable.started.tenantId !== state.tenantId)
								)
									throw new Error('This conversation belongs to another engine or owner.')
							},
							onEvent: (event) => owner.route?.(event),
							onReview: (review) => owner.review?.(review),
						})
						await owner.session.history()
						records.set(request.sessionId, owner)
						record = owner
					} catch (error) {
						closeSessions(state)
						throw error
					}
				}
				const owner = record
				if (owner.route) throw new Error('This conversation is already running.')
				owner.route = request.onEvent
				owner.review = (review) => {
					// Each turn owns its asker. Never wait for a human inside the native event sink.
					void request
						.ask({
							sessionId: request.sessionId,
							toolCalls: [
								{
									id: randomUUID(),
									name: review.title,
									input: review.input,
									isDestructive: true,
								},
							],
						})
						.then((answer) =>
							owner.session.respond(
								review,
								answer.kind === 'reject'
									? {
											kind: 'reject',
											...(answer.feedback ? { feedback: answer.feedback } : {}),
										}
									: { kind: 'approve-once' },
							),
						)
						.catch(() => {
							/* Stale/closed requests grant no authority. */
						})
				}
				try {
					const outcome = await owner.session.run({
						prompt: request.prompt,
						model: model.id,
						permissionMode: mode,
						...(request.options?.effort ? { effort: request.options.effort } : {}),
						signal: request.signal,
					})
					return {
						stopReason:
							outcome.status === 'completed'
								? 'end_turn'
								: outcome.status === 'cancelled'
									? 'cancelled'
									: 'error',
						history: await owner.session.history(),
					}
				} finally {
					owner.route = undefined
					owner.review = undefined
					await refreshIndex(owner.state, asSessionId(request.sessionId))
				}
			} finally {
				reserving.delete(request.sessionId)
			}
		},
	}
	const liveInputStatus = base.liveInputStatus?.bind(base)
	const liveInput = base.liveInput?.bind(base)
	return {
		...base,
		gateway,
		...(liveInputStatus && liveInput
			? {
					liveInputStatus: async (id: string, scopeId?: string, scope?: CliSessionScope) => {
						if (closed) throw new Error('The connection is closed.')
						if (records.has(id) || selections.has(id) || reserving.has(id)) {
							if (scopeId !== undefined)
								throw new Error('This live prompt scope is unavailable in this engine.')
							return { available: false, inputs: [] }
						}
						return liveInputStatus(id, scopeId, scope)
					},
					liveInput: async (
						id: string,
						input: { scopeId: string; inputId: string; prompt: string },
						scope?: CliSessionScope,
					) => {
						if (closed || records.has(id) || selections.has(id) || reserving.has(id))
							throw new Error('Live input is unavailable in this engine.')
						return liveInput(id, input, scope)
					},
				}
			: {}),
		harnesses: view,
		withIdleConversationForArchive: async (id, scope, archive) => {
			const cwd = trusted(directory, scope.root)
			const record = records.get(id)
			const assertIdle = () => {
				if (
					record?.route ||
					record?.review ||
					record?.session.currentTurnId ||
					(record && !['idle', 'disconnected', 'closed'].includes(record.session.status))
				)
					throw new Error('Stop this conversation’s active work before archiving it.')
				const jobs = base.jobs(id)
				if (
					!Array.isArray(jobs) ||
					jobs.some((job) => job.status === 'running' || job.recoveryRequired)
				)
					throw new Error('Stop this conversation’s background work before archiving it.')
			}
			if (reserving.has(id))
				throw new Error('Wait for this conversation’s pending operation before archiving it.')
			assertIdle()
			if (
				record &&
				(record.session.scope.cwd !== cwd ||
					record.state.root !== scope.root ||
					record.state.projectRoot !== scope.projectRoot ||
					record.state.projectId !== scope.projectId ||
					record.state.tenantId !== scope.tenantId ||
					record.state.topicId !== scope.topicId ||
					record.state.paths.sessionLog({ sessionId: asSessionId(id) }) !==
						scope.paths.sessionLog({ sessionId: asSessionId(id) }))
			)
				throw new Error('This conversation does not belong to this archive scope.')
			reserving.add(id)
			try {
				if (record) {
					// A failed close retains the exact native owner for cleanup/retry.
					await record.session.close()
					closeSessions(record.state)
					records.delete(id)
				}
				trusted(directory, scope.root)
				assertIdle()
				return await archive()
			} finally {
				reserving.delete(id)
			}
		},
		releaseHarness: async (engine) => {
			if (!external(engine)) throw new Error('Unknown execution engine.')
			await deps.release?.(engine)
		},
		selectHarness: async (id, engine) => {
			const cwd = trusted()
			if (engine !== 'namzu' && !external(engine)) throw new Error('Unknown execution engine.')
			if (reserving.has(id) || records.get(id)?.route)
				throw new Error('Stop this conversation before changing its engine.')
			reserving.add(id)
			try {
				const loaded = { saved: await facts(id, cwd) }
				const saved = loaded.saved
				const existing = await selectionFor(id, cwd, loaded)
				if (saved && engine !== (existing?.engine ?? 'namzu'))
					throw new Error(
						'A started conversation keeps its engine. Open a new tab for another engine.',
					)
				if (engine === 'namzu') selections.delete(id)
				else {
					// Choosing an engine never waits for it to start. A list already known (this run's, or the
					// last run's) names the default; either way the engine is read in the background, and the
					// server that read starts is the one opening the conversation takes over.
					const known = await knownModels(engine, cwd)
					void modelsFor(engine, cwd, 'revalidate').catch(() => undefined)
					const model =
						existing?.engine === engine
							? existing.model
							: known?.length
								? defaultModel(known)
								: undefined
					selections.set(id, { engine, ...(model ? { model } : {}) })
				}
				return await view(id, loaded)
			} finally {
				reserving.delete(id)
			}
		},
		providerStatus: async (id) => {
			if (!id || (deps.isPal ?? ((path) => Boolean(palAtWorkspace(path))))(directory))
				return base.providerStatus(id)
			const choice = await selectionFor(id, trusted())
			const identity = choice ? await deps.identity?.(choice.engine) : undefined
			// A known list names the default at once; only an engine never read before is waited for.
			const model = choice
				? (choice.model ??
					defaultModel(
						(await knownModels(choice.engine, trusted())) ??
							(await modelsFor(choice.engine, trusted())),
					))
				: undefined
			return choice
				? {
						available: [
							{
								id: choice.engine,
								label: labels[choice.engine],
								// Empty until the engine's list is known; the picker settles on its default.
								defaultModel: model ?? '',
								...(identity ? { identity } : {}),
							},
						],
						selected: { id: choice.engine, ...(model ? { model } : {}) },
					}
				: base.providerStatus(id)
		},
		models: async (provider, id) => {
			if (!external(provider)) return base.models(provider, id)
			const cwd = trusted()
			if (!id || (await selectionFor(id, cwd))?.engine !== provider)
				throw new Error('Select this engine in the conversation first.')
			const rows = await modelsFor(provider, cwd, 'revalidate')
			const timings = deps.timings?.() ?? []
			return {
				models: rows.map((model) => ({
					id: model.id,
					label: model.label,
					...(model.default ? { default: true as const } : {}),
					...(model.current ? { current: true as const } : {}),
				})),
				notice: null,
				...(timings.length ? { timings } : {}),
			}
		},
		modelSettings: async (provider, model, id) => {
			if (!external(provider)) return base.modelSettings(provider, model, id)
			if (!id || (await selectionFor(id, trusted()))?.engine !== provider)
				throw new Error('Select this engine in the conversation first.')
			const { row } = await findModel(provider, trusted(), model)
			if (!row) throw new Error('Choose a model listed by this engine.')
			return {
				...(row.effortLevels ? { effortLevels: row.effortLevels } : {}),
				...(row.defaultEffort ? { effortDefault: row.defaultEffort } : {}),
			}
		},
		selectProvider: async (id, provider, model) => {
			if ((deps.isPal ?? ((path) => Boolean(palAtWorkspace(path))))(directory))
				return await base.selectProvider(id, provider, model)
			if (reserving.has(id) || records.get(id)?.route)
				throw new Error('Stop this conversation before changing its model.')
			reserving.add(id)
			try {
				const choice = await selectionFor(id, trusted())
				if (!choice) {
					if (external(provider)) throw new Error('Select the execution engine first.')
					return await base.selectProvider(id, provider, model)
				}
				if (provider !== choice.engine || !model)
					throw new Error('This conversation uses its own engine model catalogue.')
				if (!(await findModel(choice.engine, trusted(), model)).row)
					throw new Error('Choose a model listed by this engine.')
				selections.set(id, { engine: choice.engine, model })
			} finally {
				reserving.delete(id)
			}
		},
		plugins: async (cwd, id) =>
			id && (await selectionFor(id, cwd))
				? {
						plugins: [],
						live: false,
						canChange: false,
						notice: 'This engine manages its own tools and plugins.',
					}
				: base.plugins(cwd, id),
		setPluginEnabled: async (id, name, enabled, cwd) => {
			if (await selectionFor(id, cwd ?? directory))
				throw new Error('This engine manages its own plugins.')
			return base.setPluginEnabled(id, name, enabled, cwd)
		},
		close: async () => {
			closed = true
			const outcomes = await Promise.allSettled(
				[...records].map(async ([id, record]) => {
					await record.session.close()
					closeSessions(record.state)
					records.delete(id)
				}),
			)
			const failures = outcomes
				.filter((row): row is PromiseRejectedResult => row.status === 'rejected')
				.map((row) => row.reason)
			try {
				await deps.close?.()
			} catch (error) {
				failures.push(error)
			}
			try {
				await base.close()
			} catch (error) {
				failures.push(error)
			}
			if (failures.length)
				throw new AggregateError(failures, 'Failed to close conversation engines.')
		},
	}
}
