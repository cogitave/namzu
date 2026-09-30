/** Scoped operator methods; ACP owns prompts, cancellation and review. */
import { asSessionId, isEntityId } from '@namzu/sdk'
import {
	closeSessions,
	listRecent,
	loadConversation,
	openSessions,
} from '../integrations/sessions/store.js'
import { isTrusted, trustDir } from '../integrations/trust/store.js'
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

export function createDesktopHostExtensions(runtime: CliAcpRuntime, directory: string) {
	const cwd = canonicalProjectPath(directory)
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
		await withState(async (state) => {
			if (!(await state.store.getSession(asSessionId(id), state.tenantId)))
				throw new Error('This conversation does not belong to this project.')
		})
		return id
	}
	return {
		'namzu/project/status': () => ({ cwd, trusted: isTrusted(cwd) }),
		'namzu/project/trust': (params: Record<string, unknown>) => {
			if (params.confirmed !== true || text(params, 'cwd', 32768) !== cwd)
				throw new Error('Folder confirmation does not match this project.')
			trustDir(cwd)
			return { cwd, trusted: true }
		},
		'namzu/conversations/list': () => withState((state) => listRecent(state, 100)),
		'namzu/conversations/history': (params: Record<string, unknown>) =>
			withState(async (state) => {
				const messages = await loadConversation(state, asSessionId(session(params)))
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
			}),
		'namzu/providers/status': (params: Record<string, unknown>) =>
			runtime.providerStatus(params.sessionId === undefined ? undefined : session(params)),
		'namzu/providers/select': async (params: Record<string, unknown>) => {
			if (!isTrusted(cwd)) throw new Error('Trust this folder first.')
			await runtime.selectProvider(
				session(params),
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
