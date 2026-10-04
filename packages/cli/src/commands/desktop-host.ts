/** Scoped operator methods; ACP owns prompts, cancellation and review. */
import { type PalComputerInput, asSessionId, isEntityId } from '@namzu/sdk'
import {
	closeSessions,
	listRecent,
	loadConversation,
	openSessions,
} from '../integrations/sessions/store.js'
import { isTrusted, trustDir } from '../integrations/trust/store.js'
import {
	claimPalConversation,
	listPalConversations,
	palConversationBinding,
} from '../pals/conversations.js'
import {
	cliPalComputerStatus,
	cliPalScreen,
	cliPalScreenStream,
	executeCliPalComputerInput,
	getCliPalRuntime,
	returnCliPalComputerControl,
	startCliPalComputer,
	stopCliPalComputer,
	takeOverCliPalComputer,
} from '../pals/environment.js'
import { createPal, getPal, listPals, palAtWorkspace, updatePal } from '../pals/store.js'
import { canonicalProjectPath } from '../permissions/canonical-project.js'
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

export function createDesktopHostExtensions(
	runtime: CliAcpRuntime,
	directory: string,
	publishedSessionCwd?: (sessionId: string) => string | undefined,
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
	const ownedSession = async (params: Record<string, unknown>) => {
		const id = session(params)
		const durable = await withState(async (state) =>
			Boolean(await state.store.getSession(asSessionId(id), state.tenantId)),
		)
		if (!durable) {
			// New ordinary ACP sessions have no journal until their first turn.
			// Only a published slot on this connection can authorize preparation;
			// a client-supplied UUID or another workspace is never sufficient.
			let publishedHere = false
			const publishedCwd = publishedSessionCwd?.(id)
			if (!pal() && publishedCwd !== undefined) {
				try {
					publishedHere = canonicalProjectPath(publishedCwd) === cwd
				} catch {
					/* A missing or redirected workspace grants no transient ownership. */
				}
			}
			if (!publishedHere) throw new Error('This conversation does not belong to this project.')
		}
		if (pal()) await palConversationBinding(cwd, id)
		return id
	}
	const ownedPal = (params: Record<string, unknown>) => {
		const id = text(params, 'palId')
		if (!isTrusted(cwd) || pal()?.id !== id)
			throw new Error('This Pal does not own the current workspace.')
		return id
	}
	return {
		'namzu/project/status': () => ({
			cwd,
			trusted: isTrusted(cwd),
			...(pal() ? { pal: pal() } : {}),
		}),
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
			withState((state) => {
				const currentPal = pal()
				return currentPal ? listPalConversations(cwd, currentPal.id) : listRecent(state, 100)
			}),
		'namzu/conversations/history': async (params: Record<string, unknown>) => {
			const id = await ownedSession(params)
			return withState(async (state) => {
				const messages = await loadConversation(state, asSessionId(id))
				const shown = messages.filter(
					(message) =>
						message.role === 'assistant' ||
						(message.role === 'user' &&
							(!message.source ||
								(message.source.type === 'runtime-context' && message.source.kind === 'steering'))),
				)
				let remaining = 200_000
				let partial = false
				const rows: { role: 'user' | 'assistant'; text: string }[] = []
				for (const message of shown.slice(-200).reverse()) {
					if (remaining <= 0) break
					const content = typeof message.content === 'string' ? message.content : '[Media message]'
					const value = content.slice(0, Math.min(32_000, remaining))
					partial ||= value.length < content.length
					remaining -= value.length
					rows.unshift({
						role: message.role as 'user' | 'assistant',
						text: value,
					})
				}
				return {
					messages: rows,
					partial: partial || rows.length < shown.length || remaining <= 0,
				}
			})
		},
		'namzu/providers/status': async (params: Record<string, unknown>) => {
			const id = params.sessionId === undefined ? undefined : await ownedSession(params)
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
			return ownedSession(params).then((id) => runtime.models(provider, id))
		},
		'namzu/providers/settings': async (params: Record<string, unknown>) =>
			runtime.modelSettings(
				text(params, 'provider'),
				text(params, 'model'),
				params.sessionId === undefined ? undefined : await ownedSession(params),
			),
		'namzu/plugins/list': async (params: Record<string, unknown>) => {
			const id = params.sessionId === undefined ? undefined : await ownedSession(params)
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
			runtime.jobs(await ownedSession(params)),
		'namzu/jobs/read': async (params: Record<string, unknown>) =>
			runtime.readJob(await ownedSession(params), text(params, 'jobId')),
		'namzu/jobs/stop': async (params: Record<string, unknown>) =>
			runtime.stopJob(await ownedSession(params), text(params, 'jobId')),
	}
}
