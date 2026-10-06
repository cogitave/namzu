/** Scoped operator methods; ACP owns prompts, cancellation and review. */
import { lstat } from 'node:fs/promises'
import {
	type AcpSessionPromptParams,
	type AcpSessionPromptResult,
	type AssistantMessage,
	DiskTaskStore,
	type PalComputerInput,
	type SessionRecord,
	asSessionId,
	isEntityId,
	selectAssistantText,
} from '@namzu/sdk'
import {
	type CliSessionScope,
	archiveConversation,
	closeSessions,
	listRecent,
	loadConversation,
	loadConversationSnapshot,
	openSessionScope,
	openSessions,
	readConversationFacts,
} from '../integrations/sessions/store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { isTrusted, isTrustedAtStateRoot, trustDir } from '../integrations/trust/store.js'
import {
	claimPalConversation,
	listPalConversations,
	palConversationBinding,
} from '../pals/conversations.js'
import { createDesktopPalCommunicationExtensions } from '../pals/desktop-communication.js'
import {
	cliPalComputerStatus,
	cliPalScreen,
	cliPalScreenStream,
	executeCliPalComputerInput,
	existingCliPalRuntime,
	getCliPalRuntime,
	returnCliPalComputerControl,
	startCliPalComputer,
	stopCliPalComputer,
	takeOverCliPalComputer,
} from '../pals/environment.js'
import { palPublicAssistantText } from '../pals/public-transcript.js'
import { createPal, deletePal, getPal, listPals, palAtWorkspace, updatePal } from '../pals/store.js'
import { canonicalProjectPath } from '../permissions/canonical-project.js'
import type { CliHarnessRuntime } from './acp-harness.js'
import type { CliAcpRuntime } from './acp.js'

function text(params: Record<string, unknown>, key: string, max = 400): string {
	const value = params[key]
	if (typeof value !== 'string' || !value.trim() || value.length > max)
		throw new Error(`Invalid ${key}.`)
	return value
}
function session(params: Record<string, unknown>): string {
	const value = text(params, 'sessionId')
	if (!isEntityId(value, 'session')) throw new Error('Invalid conversation id.')
	return value
}

/** Preserve only a phase proved by the selected, unchanged public text. */
function storedAssistantPhase(
	message: AssistantMessage,
): 'commentary' | 'final_answer' | undefined {
	const parts = message.textParts
	if (!parts?.length || typeof message.content !== 'string') return undefined
	if (selectAssistantText(parts) !== message.content) return undefined
	const finals = parts.filter((part) => part.phase === 'final_answer')
	const selected = finals.length ? finals : parts
	const phase = selected[0]?.phase
	return phase && selected.every((part) => part.phase === phase) ? phase : undefined
}

/** Only a durable completion for this exact, unchanged Pal reply can hide it. */
function cancelledPalReplies(records: readonly SessionRecord[]): ReadonlyMap<string, string> {
	const messages = new Map<string, { turnId: string; seq: number; ambiguous: boolean }>()
	const completions = new Map<
		string,
		{ turnId: string; seq: number; stopReason: string; content?: string }
	>()
	const replacements = new Map<string, number>()
	for (const record of records) {
		if (record.type === 'message' && record.role === 'assistant') {
			const previous = messages.get(record.messageId)
			messages.set(record.messageId, {
				turnId: record.turnId,
				seq: record.seq,
				ambiguous: Boolean(previous && (previous.ambiguous || previous.turnId !== record.turnId)),
			})
		} else if (record.type === 'message_completed') {
			completions.set(record.messageId, {
				turnId: record.turnId,
				seq: record.seq,
				stopReason: record.stopReason,
				...(record.content === undefined ? {} : { content: record.content }),
			})
		} else if (record.type === 'message_replaced') {
			replacements.set(record.targetMessageId, record.seq)
		}
	}
	const cancelled = new Map<string, string>()
	for (const [id, completion] of completions) {
		const message = messages.get(id)
		if (
			completion.stopReason === 'cancelled' &&
			typeof completion.content === 'string' &&
			message &&
			!message.ambiguous &&
			message.turnId === completion.turnId &&
			message.seq < completion.seq &&
			(replacements.get(id) ?? 0) < completion.seq
		)
			cancelled.set(id, completion.content)
	}
	return cancelled
}

export function createDesktopHostExtensions(
	runtime: CliAcpRuntime,
	directory: string,
	publishedSessionCwd?: (sessionId: string) => string | undefined,
	retrySession?: (
		sessionId: string,
		turnId: string,
		checkpointId: string,
		options?: AcpSessionPromptParams['options'],
	) => Promise<AcpSessionPromptResult>,
) {
	const cwd = canonicalProjectPath(directory)
	const pal = () => palAtWorkspace(cwd)
	const withState = async <T>(
		run: (state: Awaited<ReturnType<typeof openSessions>>) => Promise<T>,
	): Promise<T> => {
		if (!isTrusted(cwd)) throw new Error('Trust this folder before opening its conversations.')
		const state = await openSessions(cwd)
		try {
			return await run(state)
		} finally {
			closeSessions(state)
		}
	}
	const withReadScope = async <T>(run: (state: CliSessionScope) => Promise<T>): Promise<T> => {
		const root = resolveNamzuHome()
		if (!isTrustedAtStateRoot(cwd, root))
			throw new Error('Trust this folder before opening its conversations.')
		const scope = await openSessionScope(cwd, { stateRoot: root })
		if (!isTrustedAtStateRoot(cwd, scope.root))
			throw new Error('Trust this folder before opening its conversations.')
		return await run(scope)
	}
	const ownedSessionIn = async (params: Record<string, unknown>, state: CliSessionScope) => {
		const id = session(params)
		const durable = Boolean(await state.store.getSession(asSessionId(id), state.tenantId))
		const currentPal = palAtWorkspace(cwd, state.root)
		if (!durable) {
			// New ordinary ACP sessions have no journal until their first turn.
			// Only a published slot on this connection can authorize preparation;
			// a client-supplied UUID or another workspace is never sufficient.
			let publishedHere = false
			const publishedCwd = publishedSessionCwd?.(id)
			if (!currentPal && publishedCwd !== undefined) {
				try {
					publishedHere = canonicalProjectPath(publishedCwd) === cwd
				} catch {
					/* A missing or redirected workspace grants no transient ownership. */
				}
			}
			if (!publishedHere) throw new Error('This conversation does not belong to this project.')
		}
		if (currentPal) {
			const binding = await palConversationBinding(cwd, id, state)
			if (!binding || binding.pal.id !== currentPal.id)
				throw new Error('This conversation is not claimed by this Pal.')
		}
		return id
	}
	const ownedSession = (params: Record<string, unknown>) =>
		withState((state) => ownedSessionIn(params, state))
	const ownedReadSession = (params: Record<string, unknown>) =>
		withReadScope((state) => ownedSessionIn(params, state))
	const ownedPal = (params: Record<string, unknown>) => {
		const id = text(params, 'palId')
		if (!isTrusted(cwd) || pal()?.id !== id)
			throw new Error('This Pal does not own the current workspace.')
		return id
	}
	const retryStatus = runtime.providerRetryStatus?.bind(runtime)
	return {
		...(retryStatus && retrySession
			? {
					'namzu/sessions/retry-status': async (params: Record<string, unknown>) =>
						withReadScope(async (state) =>
							retryStatus(await ownedSessionIn(params, state), cwd, state),
						),
					'namzu/sessions/retry': async (params: Record<string, unknown>) => {
						if (
							Object.keys(params).some(
								(key) => !['sessionId', 'turnId', 'checkpointId', 'options'].includes(key),
							)
						)
							throw new Error(
								'Retry accepts only the original turn, checkpoint and explicit settings; send a new message after the turn settles.',
							)
						const id = await ownedSession(params)
						const turnId = text(params, 'turnId')
						const checkpointId = text(params, 'checkpointId')
						if (!isEntityId(turnId, 'turn') || !isEntityId(checkpointId, 'checkpoint'))
							throw new Error('Invalid retry turn or checkpoint.')
						return retrySession(
							id,
							turnId,
							checkpointId,
							params.options as AcpSessionPromptParams['options'],
						)
					},
				}
			: {}),
		'namzu/harnesses/list': async (params: Record<string, unknown>) => {
			if (pal())
				return {
					selected: 'namzu',
					locked: true,
					engines: [{ id: 'namzu', label: 'Namzu', available: true }],
				}
			const id = params.sessionId === undefined ? undefined : await ownedReadSession(params)
			const harness = runtime as Partial<CliHarnessRuntime>
			return harness.harnesses
				? harness.harnesses(id)
				: {
						selected: 'namzu',
						locked: false,
						engines: [{ id: 'namzu', label: 'Namzu', available: true }],
					}
		},
		'namzu/harnesses/select': async (params: Record<string, unknown>) => {
			if (pal()) throw new Error('External engines are available in normal conversations only.')
			const harness = runtime as Partial<CliHarnessRuntime>
			if (!harness.selectHarness) throw new Error('Update Namzu to use external engines.')
			return harness.selectHarness(await ownedSession(params), text(params, 'engine'))
		},
		'namzu/project/status': () => ({
			cwd,
			trusted: isTrusted(cwd),
			...(pal() ? { pal: pal() } : {}),
		}),
		...createDesktopPalCommunicationExtensions({ cwd, withState }),
		'namzu/pals/list': () => listPals(),
		'namzu/pals/get': (params: Record<string, unknown>) => getPal(text(params, 'id')),
		'namzu/pals/create': (params: Record<string, unknown>) =>
			createPal({
				name: text(params, 'name', 80),
				...(params.purpose === undefined ? {} : { purpose: params.purpose as string }),
				...(params.model === undefined ? {} : { model: params.model as never }),
				...(params.appearance === undefined ? {} : { appearance: params.appearance as never }),
			}),
		'namzu/pals/update': async (params: Record<string, unknown>) => {
			if (!Number.isSafeInteger(params.expectedRevision) || (params.expectedRevision as number) < 1)
				throw new Error('Invalid Pal revision.')
			const id = text(params, 'id')
			if (pal()?.id === id && (await getCliPalRuntime()).busy(id))
				throw new Error('Stop this Pal’s active work before changing it.')
			return updatePal(id, params.expectedRevision as number, {
				...(params.name === undefined ? {} : { name: params.name as string }),
				...(params.purpose === undefined ? {} : { purpose: params.purpose as string }),
				...(params.model === undefined ? {} : { model: params.model as never }),
				...(params.appearance === undefined ? {} : { appearance: params.appearance as never }),
				...(params.paused === undefined ? {} : { paused: params.paused as boolean }),
			})
		},
		'namzu/pals/delete': async (params: Record<string, unknown>) => {
			if (
				!params ||
				typeof params !== 'object' ||
				Array.isArray(params) ||
				Object.keys(params).some((key) => key !== 'id' && key !== 'expectedRevision')
			)
				throw new Error('Invalid Pal deletion request.')
			const id = text(params, 'id')
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id))
				throw new Error('Invalid Pal id.')
			const expectedRevision = params.expectedRevision as number
			if (
				!Number.isSafeInteger(expectedRevision) ||
				expectedRevision < 1 ||
				!Number.isSafeInteger(expectedRevision + 1)
			)
				throw new Error('Invalid Pal revision.')
			const home = resolveNamzuHome()
			const active = await existingCliPalRuntime()
			const currentPal = palAtWorkspace(cwd, home)
			if (currentPal && currentPal.id !== id)
				throw new Error('This Pal does not own the current workspace.')
			if (active && (active.busy(id) || active.computer(id)))
				throw new Error('Stop this Pal’s active work and computer before deleting it.')
			deletePal(id, expectedRevision, home)
			return { id, deleted: true as const }
		},
		'namzu/pals/computer/status': (params: Record<string, unknown>) =>
			cliPalComputerStatus(ownedPal(params)),
		'namzu/pals/computer/start': (params: Record<string, unknown>) =>
			startCliPalComputer(ownedPal(params)),
		'namzu/pals/computer/stop': (params: Record<string, unknown>) =>
			stopCliPalComputer(ownedPal(params)),
		'namzu/pals/computer/screen': (params: Record<string, unknown>) =>
			cliPalScreen(
				ownedPal(params),
				params.generation === undefined ? undefined : text(params, 'generation', 16),
			),
		'namzu/pals/computer/stream': (params: Record<string, unknown>) =>
			cliPalScreenStream(ownedPal(params), text(params, 'generation', 16)),
		'namzu/pals/computer/take_over': (params: Record<string, unknown>) =>
			takeOverCliPalComputer(ownedPal(params), text(params, 'generation', 16)),
		'namzu/pals/computer/return_control': (params: Record<string, unknown>) =>
			returnCliPalComputerControl(ownedPal(params), text(params, 'generation', 16)),
		'namzu/pals/computer/input': (params: Record<string, unknown>) =>
			executeCliPalComputerInput(
				ownedPal(params),
				text(params, 'generation', 16),
				params.input as PalComputerInput,
			),
		'namzu/pals/conversations/claim': async (params: Record<string, unknown>) => {
			if (!isTrusted(cwd)) throw new Error('This Pal workspace is not trusted.')
			return claimPalConversation(cwd, text(params, 'palId'), session(params))
		},
		'namzu/pals/conversations/list': (params: Record<string, unknown>) =>
			listPalConversations(cwd, text(params, 'palId')),
		'namzu/project/trust': (params: Record<string, unknown>) => {
			if (params.confirmed !== true || text(params, 'cwd', 32768) !== cwd)
				throw new Error('Folder confirmation does not match this project.')
			trustDir(cwd)
			return { cwd, trusted: true }
		},
		'namzu/conversations/list': () =>
			withState(async (state) => {
				const currentPal = pal()
				if (currentPal) return listPalConversations(cwd, currentPal.id)
				return Promise.all(
					(await listRecent(state, 100)).map(async (row) => {
						const engine = (await readConversationFacts(state, row.id))?.started.harness?.engineId
						return {
							...row,
							...(engine === 'codex'
								? { harness: 'codex-cli' }
								: engine === 'claude'
									? { harness: 'claude-code' }
									: {}),
						}
					}),
				)
			}),
		'namzu/conversations/history': async (params: Record<string, unknown>) => {
			return withReadScope(async (state) => {
				const id = await ownedSessionIn(params, state)
				const ownedPal = Boolean(palAtWorkspace(cwd, state.root))
				const palSnapshot = ownedPal
					? await loadConversationSnapshot(state, asSessionId(id))
					: undefined
				const messages = palSnapshot?.messages ?? (await loadConversation(state, asSessionId(id)))
				const cancelled = palSnapshot && cancelledPalReplies(palSnapshot.records)
				const shown = messages.flatMap<{
					role: 'user' | 'assistant'
					content: string | null
					phase?: 'commentary' | 'final_answer'
				}>((message) => {
					if (message.role === 'assistant') {
						if (!ownedPal) {
							// A tool-only assistant has no public message body or media.
							if (message.content === null && message.toolCalls?.length) return []
							const phase = storedAssistantPhase(message)
							return [{ role: message.role, content: message.content, ...(phase ? { phase } : {}) }]
						}
						if (message.id && cancelled?.get(message.id) === message.content) return []
						const content = palPublicAssistantText(message)
						return content === undefined ? [] : [{ role: message.role, content }]
					}
					return message.role === 'user' &&
						(!message.source ||
							(message.source.type === 'runtime-context' && message.source.kind === 'steering'))
						? [{ role: message.role, content: message.content }]
						: []
				})
				let remaining = 200_000
				let partial = false
				const rows: {
					role: 'user' | 'assistant'
					text: string
					phase?: 'commentary' | 'final_answer'
				}[] = []
				for (const message of shown.slice(-200).reverse()) {
					if (remaining <= 0) break
					const content = typeof message.content === 'string' ? message.content : '[Media message]'
					const value = content.slice(0, Math.min(32_000, remaining))
					partial ||= value.length < content.length
					remaining -= value.length
					rows.unshift({
						role: message.role as 'user' | 'assistant',
						text: value,
						...(message.phase ? { phase: message.phase } : {}),
					})
				}
				return {
					messages: rows,
					partial: partial || rows.length < shown.length || remaining <= 0,
				}
			})
		},
		'namzu/conversations/archive': async (params: Record<string, unknown>) => {
			if (
				!params ||
				typeof params !== 'object' ||
				Array.isArray(params) ||
				Object.keys(params).some((key) => key !== 'sessionId')
			)
				throw new Error('Invalid conversation archive request.')
			const requestedId = session(params)
			const home = resolveNamzuHome()
			const assertTrust = () => {
				if (!isTrustedAtStateRoot(cwd, home))
					throw new Error('Trust this folder before archiving its conversations.')
			}
			assertTrust()
			const state = await openSessions(cwd, { stateRoot: home })
			try {
				assertTrust()
				const id = asSessionId(requestedId)
				const facts = await readConversationFacts(state, id)
				const assertJobsIdle = () => {
					const jobs = runtime.jobs(id)
					if (
						!Array.isArray(jobs) ||
						jobs.some((job) => job.status === 'running' || job.recoveryRequired)
					)
						throw new Error('Stop this conversation’s background work before archiving it.')
				}
				if (!facts) {
					let absent = false
					try {
						await lstat(state.paths.sessionLog({ sessionId: id }))
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
						absent = true
					}
					if (!absent)
						throw new Error('This conversation’s journal has no verified session header.')
					const publishedCwd = publishedSessionCwd?.(id)
					if (publishedCwd !== undefined && canonicalProjectPath(publishedCwd) !== cwd)
						throw new Error('This conversation does not belong to this project.')
					assertJobsIdle()
					assertTrust()
					// Absence is an observation, never an archive or execution admission.
					return { sessionId: id, archived: false as const, missing: true as const }
				}
				await ownedSessionIn({ sessionId: requestedId }, state)
				if (facts.activeTurn)
					throw new Error('Resolve this conversation’s open turn before archiving it.')
				assertJobsIdle()
				assertTrust()
				const archive = async () => {
					assertJobsIdle()
					assertTrust()
					try {
						await archiveConversation(state, id)
					} catch (error) {
						// An idempotent retry still passes the real writer/scope gate.
						if (
							!(error instanceof Error) ||
							error.message !== `Conversation ${id} is already archived.`
						)
							throw error
						const current = await readConversationFacts(state, id)
						if (!current?.archived || current.activeTurn) throw error
					}
					return { sessionId: id, archived: true as const }
				}
				const harness = runtime as Partial<CliHarnessRuntime>
				return !palAtWorkspace(cwd, state.root) &&
					typeof harness.withIdleConversationForArchive === 'function'
					? await harness.withIdleConversationForArchive(id, state, archive)
					: await archive()
			} finally {
				closeSessions(state)
			}
		},
		'namzu/tasks/list': async (params: Record<string, unknown>) => {
			return withReadScope(async (state) => {
				const id = asSessionId(await ownedSessionIn(params, state))
				const store = new DiskTaskStore({
					paths: state.paths,
					session: { sessionId: id },
					tenantId: state.tenantId,
				})
				let records: Awaited<ReturnType<DiskTaskStore['listStrict']>>
				try {
					records = await store.listStrict({ sessionId: id })
				} catch {
					throw new Error('Task list unavailable; its records could not be read completely.')
				}
				const tasks = records
					.filter((task) => task.sessionId === id && task.tenantId === state.tenantId)
					.map((task) => ({
						taskId: task.id,
						subject: task.subject,
						status: task.status,
						blockedBy: [...task.blockedBy],
						...(task.owner === undefined ? {} : { owner: task.owner }),
					}))
				return { tasks }
			})
		},
		'namzu/providers/status': async (params: Record<string, unknown>) => {
			const id = params.sessionId === undefined ? undefined : await ownedReadSession(params)
			const status = await runtime.providerStatus(id)
			const model = id ? undefined : pal()?.model
			if (!model) return status
			return {
				...(status as Record<string, unknown>),
				selected: {
					id: model.provider,
					model: model.model,
				},
			}
		},
		'namzu/providers/models': (params: Record<string, unknown>) => {
			const provider = text(params, 'provider')
			if (params.sessionId === undefined) return runtime.models(provider)
			session(params)
			return ownedReadSession(params).then((id) => runtime.models(provider, id))
		},
		'namzu/providers/settings': async (params: Record<string, unknown>) =>
			runtime.modelSettings(
				text(params, 'provider'),
				text(params, 'model'),
				params.sessionId === undefined ? undefined : await ownedReadSession(params),
			),
		'namzu/plugins/list': async (params: Record<string, unknown>) => {
			const id = params.sessionId === undefined ? undefined : await ownedReadSession(params)
			if (pal())
				return {
					plugins: [],
					live: false,
					canChange: false,
					notice: 'Host plugins are not inherited by Pals.',
				}
			return runtime.plugins(cwd, id)
		},
		'namzu/plugins/set_enabled': async (params: Record<string, unknown>) => {
			if (!isTrusted(cwd)) throw new Error('Trust this folder first.')
			if (typeof params.enabled !== 'boolean') throw new Error('Invalid plugin choice.')
			return runtime.setPluginEnabled(
				await ownedSession(params),
				text(params, 'name'),
				params.enabled,
				cwd,
			)
		},
		'namzu/providers/select': async (params: Record<string, unknown>) => {
			if (!isTrusted(cwd)) throw new Error('Trust this folder first.')
			await runtime.selectProvider(
				await ownedSession(params),
				text(params, 'provider'),
				params.model === undefined ? undefined : text(params, 'model'),
			)
			return { selected: true }
		},
		'namzu/jobs/list': async (params: Record<string, unknown>) =>
			runtime.jobs(await ownedReadSession(params)),
		'namzu/jobs/read': async (params: Record<string, unknown>) =>
			runtime.readJob(await ownedReadSession(params), text(params, 'jobId')),
		'namzu/jobs/stop': async (params: Record<string, unknown>) =>
			runtime.stopJob(await ownedSession(params), text(params, 'jobId')),
	}
}
