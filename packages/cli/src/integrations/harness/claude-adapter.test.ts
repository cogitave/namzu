import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type HarnessBinding,
	type HarnessEvent,
	type HarnessPrompt,
	type HarnessReviewRequest,
	InMemorySessionLog,
	createHarnessSession,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClaudeHarnessAdapter, discoverClaudeHarnessModels } from './claude-adapter.js'
import { ClaudeTurnProjection, claudeJson, claudeModels } from './claude-protocol.js'
import type { HarnessProcessOptions, NativeHarnessCommand } from './process.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

const models = [
	{ value: 'sonnet', displayName: 'Engine model' },
	{ value: 'opus-5', resolvedModel: 'claude-opus-5', displayName: 'Other engine model' },
]
class WireFixture {
	command!: NativeHarnessCommand
	options!: HarnessProcessOptions
	readonly writes: Record<string, unknown>[] = []
	readonly closed = deferred<void>()
	closeCount = 0
	closeFailure: Error | undefined
	controlReply = true
	writeHook: ((frame: Record<string, unknown>) => Promise<void>) | undefined
	readonly start = (command: NativeHarnessCommand, options: HarnessProcessOptions) => {
		this.command = command
		this.options = options
		return {
			closed: this.closed.promise,
			write: async (raw: unknown) => {
				const frame = raw as Record<string, unknown>
				this.writes.push(JSON.parse(JSON.stringify(frame)))
				if (this.writeHook) await this.writeHook(frame)
				if (frame.type === 'control_request' && this.controlReply) {
					const request = frame.request as { subtype: string }
					await this.emit({
						type: 'control_response',
						response: {
							subtype: 'success',
							request_id: frame.request_id,
							response: ['initialize', 'list_models'].includes(request.subtype) ? { models } : {},
						},
					})
				}
			},
			close: async () => {
				this.closeCount++
				if (this.closeFailure) throw this.closeFailure
				await options.onClosed()
				this.closed.resolve()
				return { stopped: true as const }
			},
		}
	}
	emit(frame: unknown) {
		return Promise.resolve(this.options.onFrame(frame))
	}
	userWrites() {
		return this.writes.filter((frame) => frame.type === 'user')
	}
}

let cwd: string
let fixture: WireFixture
let events: HarnessEvent[]
beforeEach(async () => {
	cwd = await realpath(await mkdtemp(join(tmpdir(), 'namzu-native-engine-test-')))
	fixture = new WireFixture()
	events = []
})
afterEach(async () => {
	vi.useRealTimers()
	await rm(cwd, { recursive: true, force: true })
})

function adapter(env?: NodeJS.ProcessEnv) {
	return createClaudeHarnessAdapter({
		profileRef: 'fixture-owner',
		executable: '/fixture/native-engine',
		env,
		startProcess: fixture.start,
		resolveExecutable: async () => '/fixture/native-engine',
	})
}
function open(resume?: HarnessBinding) {
	return adapter().open({ cwd, model: 'sonnet', resume }, async (event) => {
		events.push(event)
	})
}
function prompt(
	operationId = 'operation-1',
	overrides: Partial<HarnessPrompt> = {},
): HarnessPrompt {
	return {
		operationId,
		model: 'sonnet',
		prompt: 'fixture user input',
		permissionMode: 'prompt',
		...overrides,
	}
}
function assistant(session: string, id: string, text = 'public response') {
	return {
		type: 'assistant',
		session_id: session,
		message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text }] },
	}
}
function result(session: string, id = 'result-1', extra: Record<string, unknown> = {}) {
	return {
		type: 'result',
		session_id: session,
		uuid: id,
		subtype: 'success',
		is_error: false,
		result: 'public response',
		...extra,
	}
}
function partialMessage(session: string, id: string, text: string): Record<string, unknown>[] {
	return [
		{ type: 'message_start', message: { id } },
		{
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'text', text: '' },
		},
		{
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'text_delta', text },
		},
	].map((event) => ({ type: 'stream_event', session_id: session, event }))
}
function request(session: string, id = 'request-1', input = { command: 'echo fixture' }) {
	return {
		type: 'control_request',
		session_id: session,
		request_id: id,
		request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: `tool-${id}`, input },
	}
}
function review(): HarnessReviewRequest {
	const event = events.find((item) => item.kind === 'review-requested')
	if (!event || event.kind !== 'review-requested') throw new Error('Missing fixture review')
	return event.request
}

describe('native engine unfinished message settlement', () => {
	it.each([
		{
			label: 'successful',
			frame: {},
			status: 'completed',
			stopReason: 'end_turn',
		},
		{
			label: 'failed success subtype',
			frame: { is_error: true },
			status: 'failed',
			stopReason: 'cancelled',
		},
		{
			label: 'failed error subtype',
			frame: { subtype: 'error_during_execution' },
			status: 'failed',
			stopReason: 'cancelled',
		},
		{
			label: 'interrupted',
			frame: { subtype: 'error_interrupted', is_error: true },
			status: 'cancelled',
			stopReason: 'cancelled',
		},
	])(
		'settles an unfinished $label message without rewriting an earlier completed message',
		({ frame, status, stopReason }) => {
			const turn = {
				nativeSessionId: 'projection-session',
				nativeTurnId: 'projection-operation',
				turnIdSource: 'operation' as const,
			}
			const projection = new ClaudeTurnProjection(turn, new Set())
			const completed = projection.consume(assistant(turn.nativeSessionId, 'already-completed'))
			expect(completed).toContainEqual({
				...turn,
				kind: 'message-completed',
				nativeItemId: 'already-completed',
				content: 'public response',
				stopReason: 'end_turn',
			})
			for (const item of partialMessage(turn.nativeSessionId, 'unfinished', 'Partial reply'))
				projection.consume(item)
			const terminal = projection.consume(result(turn.nativeSessionId, 'terminal', frame))
			expect(terminal.filter((event) => event.kind === 'message-completed')).toEqual([
				{
					...turn,
					kind: 'message-completed',
					nativeItemId: 'unfinished',
					content: 'Partial reply',
					stopReason,
				},
			])
			expect(terminal.find((event) => event.kind === 'turn-completed')).toMatchObject({ status })
			if (status === 'failed')
				expect(terminal.find((event) => event.kind === 'turn-completed')).toMatchObject({
					error: { code: 'native-turn-failed' },
				})
			expect(
				projection.consume(assistant(turn.nativeSessionId, 'unfinished', 'Late complete reply')),
			).toEqual([])
			expect(
				projection.consume(
					assistant(turn.nativeSessionId, 'already-completed', 'Late changed reply'),
				),
			).toEqual([])
		},
	)

	it.each(['failure', 'interrupt'] as const)(
		'retains partial %s text and refuses late native completion in a later operation',
		async (kind) => {
			const connection = await open()
			try {
				const turn = await connection.dispatch(prompt())
				for (const frame of partialMessage(
					turn.nativeSessionId,
					'unfinished-message',
					'Partial reply',
				))
					await fixture.emit(frame)
				if (kind === 'interrupt') {
					await connection.interrupt(turn)
					expect(events.some((event) => event.kind === 'turn-completed')).toBe(false)
				}
				const terminal = result(turn.nativeSessionId, 'unfinished-result', {
					is_error: true,
					subtype: kind === 'interrupt' ? 'error_interrupted' : 'error_during_execution',
				})
				await fixture.emit(terminal)
				expect(events.filter((event) => event.kind === 'message-completed')).toEqual([
					{
						...turn,
						kind: 'message-completed',
						nativeItemId: 'unfinished-message',
						content: 'Partial reply',
						stopReason: 'cancelled',
					},
				])
				expect(events.filter((event) => event.kind === 'turn-completed')).toMatchObject([
					{ status: kind === 'interrupt' ? 'cancelled' : 'failed' },
				])
				const next = await connection.dispatch(prompt('operation-2'))
				await fixture.emit(
					assistant(turn.nativeSessionId, 'unfinished-message', 'Late complete reply'),
				)
				for (const frame of partialMessage(
					turn.nativeSessionId,
					'unfinished-message',
					'Late streamed reply',
				))
					await fixture.emit(frame)
				await fixture.emit(terminal)
				expect(events.filter((event) => event.kind === 'message-completed')).toHaveLength(1)
				expect(events.filter((event) => event.kind === 'turn-completed')).toHaveLength(1)
				await fixture.emit(assistant(next.nativeSessionId, 'next-message', 'Next complete reply'))
				await fixture.emit(
					result(next.nativeSessionId, 'next-result', {
						result: 'Next complete reply',
					}),
				)
				expect(events.filter((event) => event.kind === 'message-completed').at(-1)).toEqual({
					...next,
					kind: 'message-completed',
					nativeItemId: 'next-message',
					content: 'Next complete reply',
					stopReason: 'end_turn',
				})
				expect(events.filter((event) => event.kind === 'turn-completed').at(-1)).toMatchObject({
					status: 'completed',
				})
			} finally {
				await connection.close()
			}
		},
	)

	it('journals unfinished text with cancelled message lifecycle while its native turn remains failed', async () => {
		const sessionId = generateSessionId()
		const log = new InMemorySessionLog({ sessionId })
		const session = createHarnessSession({
			scope: {
				sessionId,
				tenantId: generateTenantId(),
				projectId: generateProjectId(),
				topicId: generateTopicId(),
				cwd,
			},
			sessionLog: log,
			adapter: adapter(),
			assertAdmission: async () => undefined,
			onEvent: () => undefined,
			onReview: () => {
				throw new Error('This message-only fixture must not request tool approval.')
			},
		})
		const dispatched = deferred<string>()
		fixture.writeHook = async (frame) => {
			if (frame.type === 'user') dispatched.resolve(frame.session_id as string)
		}
		const pending = session.run({
			prompt: 'fixture interrupted request',
			model: 'sonnet',
			permissionMode: 'prompt',
		})
		try {
			const nativeSessionId = await dispatched.promise
			for (const frame of partialMessage(
				nativeSessionId,
				'unfinished-journal-message',
				'Partial journal reply',
			))
				await fixture.emit(frame)
			await fixture.emit(
				result(nativeSessionId, 'failed-journal-result', {
					is_error: true,
					api_error_status: 401,
					result: 'SYNTHETIC_REMOTE_DIAGNOSTIC',
				}),
			)
			expect((await pending).status).toBe('failed')
			const records = (await log.readAll()).entries.map((entry) => entry.record)
			expect(records.filter((record) => record.type === 'message_completed')).toMatchObject([
				{ content: 'Partial journal reply', stopReason: 'cancelled' },
			])
			expect(records.filter((record) => record.type === 'turn_failed')).toMatchObject([
				{ settlement: { status: 'failed' } },
			])
			expect(records.filter((record) => record.type === 'turn_completed')).toEqual([])
			expect(
				(await session.history()).filter((message) => message.role === 'assistant'),
			).toMatchObject([{ content: 'Partial journal reply' }])
			expect(JSON.stringify(records)).not.toContain('SYNTHETIC_REMOTE_DIAGNOSTIC')
			const beforeLateFrame = (await log.readAll()).entries.length
			await fixture.emit(
				assistant(nativeSessionId, 'unfinished-journal-message', 'Late complete journal reply'),
			)
			expect((await log.readAll()).entries).toHaveLength(beforeLateFrame)
		} finally {
			await session.close()
			await pending.catch(() => undefined)
		}
	})
})

describe('native engine model discovery', () => {
	it('uses actual metadata rows and closes its own process without sending a prompt', async () => {
		const listed = await discoverClaudeHarnessModels({
			cwd,
			startProcess: fixture.start,
			resolveExecutable: async () => '/fixture/native-engine',
		})
		expect(listed).toEqual([
			{ id: 'sonnet', label: 'Engine model' },
			{ id: 'claude-opus-5', label: 'Other engine model' },
		])
		expect(fixture.userWrites()).toEqual([])
		expect(fixture.command.args).toContain('--no-session-persistence')
		expect(fixture.command.args).not.toContain('--resume')
		expect(fixture.closeCount).toBe(1)
	})
	it('never substitutes a default table for missing or disabled native rows', () => {
		expect(() => claudeModels({})).toThrow('supported model catalogue')
		expect(
			claudeModels({
				models: [
					{ value: 'default' },
					{ value: 'hidden', disabled: true },
					{ value: 'cc-update-required' },
				],
			}),
		).toEqual([])
		expect(
			claudeModels({ models: [{ value: 'sonnet', supportedEffortLevels: ['high'] }] }),
		).toEqual([{ id: 'sonnet', label: 'sonnet' }])
	})
	it('aborts a control operation, removes the listener and confirms isolated shutdown', async () => {
		fixture.controlReply = false
		const controller = new AbortController()
		const started = deferred<void>()
		fixture.writeHook = async () => {
			started.resolve()
		}
		const pending = discoverClaudeHarnessModels({
			cwd,
			signal: controller.signal,
			startProcess: fixture.start,
			resolveExecutable: async () => '/fixture/native-engine',
		})
		await started.promise
		const failure = new Error('fixture discovery cancelled')
		controller.abort(failure)
		await expect(pending).rejects.toBe(failure)
		expect(fixture.closeCount).toBe(1)
		expect(fixture.userWrites()).toEqual([])
	})
	it('bounds a nonresponsive engine with a deterministic timeout and owned cleanup', async () => {
		vi.useFakeTimers()
		fixture.controlReply = false
		const started = deferred<void>()
		fixture.writeHook = async () => {
			started.resolve()
		}
		const pending = discoverClaudeHarnessModels({
			cwd,
			startProcess: fixture.start,
			resolveExecutable: async () => '/fixture/native-engine',
		})
		const checked = expect(pending).rejects.toThrow('did not answer')
		await started.promise
		await vi.advanceTimersByTimeAsync(15_000)
		await checked
		expect(fixture.closeCount).toBe(1)
	})
})

describe('native engine conversation ownership', () => {
	it('mints a separate native session and snapshots the selected host environment', async () => {
		const env = { PATH: '/fixture', FIXTURE_ENV: 'captured' }
		const engine = adapter(env)
		env.FIXTURE_ENV = 'mutated'
		const connection = await engine.open({ cwd, model: 'sonnet' }, async (event) => {
			events.push(event)
		})
		expect(connection.binding.cwd).toBe(cwd)
		expect(connection.binding.nativeSessionId).toMatch(/^[a-f0-9-]{36}$/)
		expect(fixture.command.args).toContain(connection.binding.nativeSessionId)
		expect(fixture.command.args).toContain('--session-id')
		expect(fixture.command.env?.FIXTURE_ENV).toBe('captured')
		expect(connection.capabilities.history).toBe('unavailable')
		expect(connection.capabilities.reviewModes).toEqual(['prompt', 'plan'])
		expect((await connection.readHistory()).complete).toBe(false)
		await connection.close()
	})
	it('resumes only the immutable engine, profile and exact execution directory', async () => {
		const first = await open()
		await first.close()
		const binding = first.binding
		fixture = new WireFixture()
		await expect(open({ ...binding, profileRef: 'foreign-profile' })).rejects.toThrow(
			'another profile',
		)
		await expect(open({ ...binding, cwd: join(cwd, 'foreign') })).rejects.toThrow('workspace')
		await expect(open({ ...binding, engineId: 'other-engine' })).rejects.toThrow('another profile')
		expect(fixture.writes).toEqual([])
		const resumed = await open(binding)
		expect(fixture.command.args).toContain('--resume')
		expect(fixture.command.args).not.toContain('--session-id')
		expect(resumed.binding).toEqual(binding)
		await resumed.close()
	})
	it('rejects an absent model and preserves initialization failure alongside cleanup failure', async () => {
		await expect(adapter().open({ cwd }, async () => {})).rejects.toThrow('Choose a model')
		fixture.writeHook = async (frame) => {
			if (frame.type === 'control_request')
				await fixture.emit({
					type: 'control_response',
					response: {
						subtype: 'error',
						request_id: frame.request_id,
						error: 'SYNTHETIC_PRIVATE_REMOTE_ERROR',
					},
				})
		}
		fixture.closeFailure = new Error('fixture stop unconfirmed')
		await expect(open()).rejects.toBeInstanceOf(AggregateError)
		expect(fixture.userWrites()).toEqual([])
	})
	it('refuses foreign parent-session frames while ignoring native subagents', async () => {
		const connection = await open()
		await connection.dispatch(prompt())
		await fixture.emit({
			...assistant('subagent', 'child-message'),
			parent_tool_use_id: 'parent-tool',
		})
		expect(events).toEqual([])
		await expect(fixture.emit(assistant('foreign-parent', 'foreign-message'))).rejects.toThrow(
			'session identity',
		)
		await connection.close()
	})
	it('does not automatically replay an operation or accept an unsupported mode/effort', async () => {
		const connection = await open()
		await expect(connection.dispatch(prompt('x', { permissionMode: 'auto' }))).rejects.toThrow(
			'supervised and plan',
		)
		await expect(connection.dispatch(prompt('x', { effort: 'high' }))).rejects.toThrow(
			'reasoning effort',
		)
		await connection.dispatch(prompt())
		await expect(connection.dispatch(prompt('concurrent'))).rejects.toThrow('still working')
		await fixture.emit(result(connection.binding.nativeSessionId))
		await expect(connection.dispatch(prompt())).rejects.toThrow('automatically replayed')
		await connection.close()
	})
})

describe('native engine stream projection', () => {
	it('captures a queued prompt before awaited model reconfiguration and sends controls first', async () => {
		const connection = await open()
		const entered = deferred<void>()
		const released = deferred<void>()
		fixture.writeHook = async (frame) => {
			if ((frame.request as { subtype?: string } | undefined)?.subtype === 'list_models') {
				entered.resolve()
				await released.promise
			}
		}
		const mutable = prompt('captured-operation', { model: 'claude-opus-5', permissionMode: 'plan' })
		const pending = connection.dispatch(mutable)
		await entered.promise
		Object.assign(mutable, {
			model: 'sonnet',
			prompt: 'mutated text',
			operationId: 'mutated-operation',
			permissionMode: 'prompt',
		})
		released.resolve()
		const turn = await pending
		expect(turn.nativeTurnId).toBe('captured-operation')
		expect(fixture.userWrites()).toMatchObject([{ message: { content: 'fixture user input' } }])
		const operations = fixture.writes.map((frame) =>
			frame.type === 'control_request'
				? (frame.request as { subtype: string }).subtype
				: frame.type,
		)
		expect(operations.slice(-4)).toEqual([
			'list_models',
			'set_model',
			'set_permission_mode',
			'user',
		])
		await fixture.emit(result(turn.nativeSessionId))
		await connection.close()
	})

	it('retains an uncertain configuration refusal rather than guessing the next native mode', async () => {
		const connection = await open()
		fixture.writeHook = async (frame) => {
			if ((frame.request as { subtype?: string } | undefined)?.subtype === 'set_permission_mode')
				throw new Error('fixture uncertain native write')
		}
		await expect(
			connection.dispatch(prompt('plan-operation', { permissionMode: 'plan' })),
		).rejects.toThrow('uncertain native write')
		await expect(connection.dispatch(prompt('new-operation'))).rejects.toThrow(
			'configuration outcome is unknown',
		)
		expect(fixture.userWrites()).toEqual([])
		await connection.close()
	})

	it('replaces partial text with one authoritative snapshot and retains distinct same-text message identities', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		const session = turn.nativeSessionId
		const stream = async (event: unknown) =>
			fixture.emit({ type: 'stream_event', session_id: session, event })
		await stream({ type: 'message_start', message: { id: 'message-a' } })
		await stream({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'text', text: '' },
		})
		await stream({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'text_delta', text: 'partial' },
		})
		await fixture.emit(assistant(session, 'message-a', 'same complete text'))
		await fixture.emit(assistant(session, 'message-a', 'same complete text'))
		await fixture.emit(assistant(session, 'message-b', 'same complete text'))
		await fixture.emit(result(session))
		expect(events.filter((event) => event.kind === 'message-started')).toHaveLength(2)
		expect(events.filter((event) => event.kind === 'text-delta')).toEqual([
			{
				...turn,
				kind: 'text-delta',
				nativeItemId: 'message-a',
				text: 'partial',
				part: { id: '0' },
			},
		])
		expect(
			events
				.filter((event) => event.kind === 'message-completed')
				.map((event) => event.nativeItemId),
		).toEqual(['message-a', 'message-b'])
		expect(events.filter((event) => event.kind === 'turn-completed')).toHaveLength(1)
		await connection.dispatch(prompt('operation-2'))
		await fixture.emit(assistant(session, 'message-a', 'late old text'))
		await fixture.emit(result(session))
		expect(events.filter((event) => event.kind === 'message-completed')).toHaveLength(2)
		expect(events.filter((event) => event.kind === 'turn-completed')).toHaveLength(1)
		await fixture.emit(result(session, 'result-2'))
		await connection.close()
	})
	it('records public thinking lifecycle without signatures or redacted replay material', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		const stream = (event: unknown) =>
			fixture.emit({ type: 'stream_event', session_id: turn.nativeSessionId, event })
		await stream({ type: 'message_start', message: { id: 'thinking-message' } })
		await stream({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'thinking', thinking: '' },
		})
		await stream({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'thinking_delta', thinking: 'public ' },
		})
		await stream({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'thinking_delta', thinking: 'thought' },
		})
		await stream({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'signature_delta', signature: 'SYNTHETIC_REPLAY_SIGNATURE' },
		})
		await stream({ type: 'content_block_stop', index: 0 })
		await fixture.emit({
			type: 'assistant',
			session_id: turn.nativeSessionId,
			message: {
				id: 'thinking-message',
				stop_reason: 'end_turn',
				content: [
					{ type: 'redacted_thinking', data: 'SYNTHETIC_PRIVATE_REPLAY' },
					{ type: 'text', text: 'answer' },
				],
			},
		})
		const thinking = events.filter((event) => event.kind === 'reasoning')
		expect(thinking.map((event) => event.status)).toEqual([
			'pending',
			'pending',
			'pending',
			'completed',
		])
		expect(thinking.map((event) => event.text)).toEqual([
			undefined,
			'public ',
			'thought',
			'public thought',
		])
		expect(JSON.stringify(events)).not.toContain('SYNTHETIC_')
		await fixture.emit(result(turn.nativeSessionId))
		await connection.close()
	})
	it('observes authoritative native tool input and result without kernel admission', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		const session = turn.nativeSessionId
		const stream = (event: unknown) =>
			fixture.emit({ type: 'stream_event', session_id: session, event })
		await stream({ type: 'message_start', message: { id: 'tool-message' } })
		await stream({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'native-tool', name: 'Bash', input: {} },
		})
		await stream({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'input_json_delta', partial_json: '{"command":"partial"}' },
		})
		await stream({ type: 'content_block_stop', index: 0 })
		expect(events.some((event) => event.kind === 'tool-started')).toBe(false)
		await fixture.emit({
			type: 'assistant',
			session_id: session,
			message: {
				id: 'tool-message',
				stop_reason: 'tool_use',
				content: [
					{
						type: 'tool_use',
						id: 'native-tool',
						name: 'Bash',
						input: { command: 'authoritative' },
					},
				],
			},
		})
		await fixture.emit({
			type: 'user',
			session_id: session,
			message: {
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'native-tool',
						content: [{ type: 'text', text: 'actual result' }],
						is_error: false,
					},
				],
			},
		})
		await fixture.emit(assistant(session, 'final-message'))
		await fixture.emit(result(session))
		expect(events.filter((event) => event.kind === 'tool-started')).toEqual([
			{
				...turn,
				kind: 'tool-started',
				nativeItemId: 'native-tool',
				name: 'Bash',
				input: { command: 'authoritative' },
			},
		])
		expect(events.filter((event) => event.kind === 'tool-completed')).toEqual([
			{
				...turn,
				kind: 'tool-completed',
				nativeItemId: 'native-tool',
				name: 'Bash',
				result: 'actual result',
				status: 'completed',
			},
		])
		await connection.close()
	})
	it('does not resurrect a turn completed before its prompt write acknowledges', async () => {
		const connection = await open()
		fixture.writeHook = async (frame) => {
			if (frame.type === 'user')
				await fixture.emit(
					result(connection.binding.nativeSessionId, `result-${fixture.userWrites().length}`),
				)
		}
		await connection.dispatch(prompt())
		await connection.dispatch(prompt('operation-2'))
		expect(events.filter((event) => event.kind === 'turn-completed')).toHaveLength(2)
		await connection.close()
	})
	it('treats error=true success subtype as failure and keeps account/remote bodies out of the notice', async () => {
		const connection = await open()
		await connection.dispatch(prompt())
		await fixture.emit(
			result(connection.binding.nativeSessionId, 'auth-error', {
				is_error: true,
				api_error_status: 401,
				result: 'SYNTHETIC_TOKEN_AND_REMOTE_BODY',
				errors: ['SYNTHETIC_ACCOUNT_DATA'],
			}),
		)
		const ended = events.find((event) => event.kind === 'turn-completed')
		expect(ended).toMatchObject({ status: 'failed', error: { code: 'authentication-required' } })
		expect(JSON.stringify(events)).not.toContain('SYNTHETIC_')
		await connection.close()
	})

	it('does not persist raw diagnostics carried by an error assistant', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		await fixture.emit({
			...assistant(turn.nativeSessionId, 'error-message', 'SYNTHETIC_RAW_AUTH_DIAGNOSTIC'),
			error: 'authentication_failed',
		})
		await fixture.emit(result(turn.nativeSessionId, 'error-result', { is_error: true }))
		expect(events.filter((event) => event.kind === 'message-completed')).toEqual([])
		expect(events.find((event) => event.kind === 'turn-completed')).toMatchObject({
			status: 'failed',
			error: { code: 'authentication-required' },
		})
		expect(JSON.stringify(await connection.readHistory())).not.toContain('SYNTHETIC_RAW')
		await connection.close()
	})

	it('refuses terminal frames missing exact native identity', async () => {
		const connection = await open()
		await connection.dispatch(prompt())
		await expect(
			fixture.emit({ type: 'result', subtype: 'success', uuid: 'unowned-result' }),
		).rejects.toThrow('omitted its owned session')
		await expect(
			fixture.emit({
				type: 'result',
				session_id: connection.binding.nativeSessionId,
				subtype: 'success',
			}),
		).rejects.toThrow('stable identity')
		expect(events.filter((event) => event.kind === 'turn-completed')).toEqual([])
		await connection.close()
	})
})

describe('native engine live permissions and cancellation', () => {
	it('journals actual adapter reviews, tools and result-only identity through the SDK boundary', async () => {
		const sessionId = generateSessionId()
		const log = new InMemorySessionLog({ sessionId })
		const reviews: HarnessReviewRequest[] = []
		const session = createHarnessSession({
			scope: {
				sessionId,
				tenantId: generateTenantId(),
				projectId: generateProjectId(),
				topicId: generateTopicId(),
				cwd,
			},
			sessionLog: log,
			adapter: adapter(),
			assertAdmission: async () => undefined,
			onEvent: () => undefined,
			onReview: (request) => {
				reviews.push(request)
			},
		})
		const dispatched = deferred<string>()
		fixture.writeHook = async (frame) => {
			if (frame.type === 'user') dispatched.resolve(frame.session_id as string)
		}
		const pending = session.run({
			prompt: 'fixture request',
			model: 'sonnet',
			permissionMode: 'prompt',
		})
		try {
			const nativeSessionId = await dispatched.promise
			await fixture.emit(request(nativeSessionId))
			expect(session.status).toBe('waiting')
			expect(reviews).toHaveLength(1)
			await session.respond(reviews[0]!, { kind: 'approve-once' })
			await fixture.emit({
				type: 'assistant',
				session_id: nativeSessionId,
				message: {
					id: 'tool-message',
					stop_reason: 'tool_use',
					content: [
						{
							type: 'tool_use',
							id: 'tool-request-1',
							name: 'Bash',
							input: { command: 'echo fixture' },
						},
					],
				},
			})
			await fixture.emit({
				type: 'user',
				session_id: nativeSessionId,
				message: {
					content: [
						{ type: 'tool_result', tool_use_id: 'tool-request-1', content: 'fixture output' },
					],
				},
			})
			const cancelled = request(nativeSessionId, 'cancelled-request')
			await fixture.emit(cancelled)
			await fixture.emit({ type: 'control_cancel_request', request_id: cancelled.request_id })
			await fixture.emit(result(nativeSessionId))
			expect((await pending).status).toBe('completed')
			expect(session.status).toBe('idle')
			const messages = await session.history()
			expect(messages.filter((message) => message.role === 'assistant').at(-1)).toMatchObject({
				content: 'public response',
			})
			const nextDispatch = deferred<string>()
			fixture.writeHook = async (frame) => {
				if (frame.type === 'user') nextDispatch.resolve(frame.session_id as string)
			}
			const next = session.run({ prompt: 'result only', model: 'sonnet', permissionMode: 'prompt' })
			await fixture.emit(result(await nextDispatch.promise, 'native-result-only'))
			expect((await next).status).toBe('completed')
			const records = (await log.readAll()).entries.map((entry) => entry.record)
			expect(records).toContainEqual(
				expect.objectContaining({
					type: 'tool_completed',
					toolName: 'claude:Bash',
					result: 'fixture output',
					isError: false,
				}),
			)
			expect(records).toContainEqual(
				expect.objectContaining({
					type: 'tool_executing',
					toolName: 'claude:Bash',
					input: { command: 'echo fixture' },
				}),
			)
			expect(records).toContainEqual(
				expect.objectContaining({
					type: 'message',
					role: 'assistant',
					content: expect.objectContaining({ content: 'public response' }),
				}),
			)
			expect(JSON.stringify(records)).toContain('native-result-only')
		} finally {
			await session.close()
			await pending.catch(() => undefined)
		}
	})
	it('denies an unsupported native question with explicit conversation feedback', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		const raw = request(turn.nativeSessionId)
		raw.request.tool_name = 'AskUserQuestion'
		await fixture.emit(raw)
		expect(events.filter((event) => event.kind === 'review-requested')).toEqual([])
		expect(fixture.writes.filter((frame) => frame.type === 'control_response')).toMatchObject([
			{
				response: {
					response: { behavior: 'deny', message: 'Answer this question in the conversation.' },
				},
			},
		])
		await fixture.emit(result(turn.nativeSessionId))
		await connection.close()
	})

	it('does not replay a native approval whose write outcome is uncertain', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		await fixture.emit(request(turn.nativeSessionId))
		fixture.writeHook = async (frame) => {
			if (frame.type === 'control_response') throw new Error('fixture unconfirmed approval')
		}
		await expect(connection.respond(review(), { kind: 'approve-once' })).rejects.toThrow(
			'unconfirmed approval',
		)
		fixture.writeHook = undefined
		await expect(connection.respond(review(), { kind: 'approve-once' })).rejects.toThrow(
			'no longer current',
		)
		expect(fixture.writes.filter((frame) => frame.type === 'control_response')).toHaveLength(1)
		await connection.close()
	})

	it('captures exact immutable request context, refuses spoofed input and sends one original decision', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		const raw = request(turn.nativeSessionId)
		await fixture.emit(raw)
		const captured = review()
		raw.request.input.command = 'mutated'
		await expect(
			connection.respond({ ...captured, nativeTurnId: 'foreign-turn' }, { kind: 'approve-once' }),
		).rejects.toThrow('no longer current')
		await expect(
			connection.respond({ ...captured, input: { command: 'spoofed' } }, { kind: 'approve-once' }),
		).rejects.toThrow('no longer current')
		await expect(
			connection.respond(captured, { kind: 'approve-once', updatedInput: 'not-an-object' }),
		).rejects.toThrow('must be an object')
		await connection.respond(captured, { kind: 'approve-once' })
		const response = fixture.writes.find((frame) => frame.type === 'control_response')
		expect(response).toMatchObject({
			response: {
				request_id: 'request-1',
				response: { behavior: 'allow', updatedInput: { command: 'echo fixture' } },
			},
		})
		await expect(connection.respond(captured, { kind: 'approve-once' })).rejects.toThrow(
			'no longer current',
		)
		await expect(fixture.emit(request(turn.nativeSessionId))).rejects.toThrow('reused a resolved')
		await fixture.emit(result(turn.nativeSessionId))
		await connection.close()
	})
	it('fences concurrent permission answers before awaiting the native write', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		await fixture.emit(request(turn.nativeSessionId))
		const hold = deferred<void>()
		const entered = deferred<void>()
		fixture.writeHook = async (frame) => {
			if (frame.type === 'control_response') {
				entered.resolve()
				await hold.promise
			}
		}
		const first = connection.respond(review(), { kind: 'reject' })
		await entered.promise
		await expect(connection.respond(review(), { kind: 'approve-once' })).rejects.toThrow(
			'no longer current',
		)
		hold.resolve()
		await first
		expect(fixture.writes.filter((frame) => frame.type === 'control_response')).toHaveLength(1)
		await fixture.emit(result(turn.nativeSessionId))
		await connection.close()
	})
	it('invalidates a native cancelled request and prevents plan transition approval', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt('operation-1', { permissionMode: 'plan' }))
		const raw = request(turn.nativeSessionId)
		raw.request.tool_name = 'ExitPlanMode'
		await fixture.emit(raw)
		const captured = review()
		await expect(connection.respond(captured, { kind: 'approve-once' })).rejects.toThrow(
			'Change the current review mode',
		)
		await fixture.emit({ type: 'control_cancel_request', request_id: captured.requestId })
		await expect(connection.respond(captured, { kind: 'reject' })).rejects.toThrow(
			'no longer current',
		)
		await fixture.emit(result(turn.nativeSessionId))
		await connection.close()
	})
	it('does not mistake interrupt ACK for terminal completion and rejects stale stop after a new turn', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		await fixture.emit(request(turn.nativeSessionId))
		await connection.interrupt(turn)
		expect(events.some((event) => event.kind === 'turn-completed')).toBe(false)
		await expect(connection.respond(review(), { kind: 'approve-once' })).rejects.toThrow(
			'no longer current',
		)
		await expect(connection.dispatch(prompt('operation-2'))).rejects.toThrow('still working')
		await fixture.emit(
			result(turn.nativeSessionId, 'cancel-result', {
				subtype: 'error_during_execution',
				is_error: true,
				terminal_reason: 'aborted_tools',
			}),
		)
		expect(events.filter((event) => event.kind === 'turn-completed')).toMatchObject([
			{ status: 'cancelled' },
		])
		await connection.dispatch(prompt('operation-2'))
		await expect(connection.interrupt(turn)).rejects.toThrow('current native turn')
		await fixture.emit(result(turn.nativeSessionId, 'second-result'))
		await connection.close()
	})
	it('keeps background native work out of the next operation and permits shutdown retries', async () => {
		const connection = await open()
		const turn = await connection.dispatch(prompt())
		await fixture.emit({
			type: 'system',
			session_id: turn.nativeSessionId,
			subtype: 'task_started',
			task_id: 'owned-background',
		})
		await fixture.emit(result(turn.nativeSessionId))
		await expect(connection.dispatch(prompt('operation-2'))).rejects.toThrow('still working')
		await fixture.emit({
			type: 'system',
			session_id: turn.nativeSessionId,
			subtype: 'task_notification',
			task_id: 'owned-background',
			status: 'completed',
		})
		await connection.dispatch(prompt('operation-2'))
		fixture.closeFailure = new Error('fixture tree stop unconfirmed')
		await expect(connection.close()).rejects.toBe(fixture.closeFailure)
		fixture.closeFailure = undefined
		await expect(connection.close()).resolves.toEqual({ stopped: true })
		expect(fixture.closeCount).toBe(2)
	})
	it('rejects invalid JSON inputs instead of laundering them through native permissions', () => {
		const safe = claudeJson(JSON.parse('{"__proto__":{"fixture":true}}'))
		expect(Object.getPrototypeOf(safe)).toBe(Object.prototype)
		expect(Object.hasOwn(safe as object, '__proto__')).toBe(true)
		expect(Object.isFrozen(safe)).toBe(true)
		expect(() => claudeJson({ value: Number.NaN })).toThrow('not JSON')
		const deep: Record<string, unknown> = {}
		let current = deep
		for (let n = 0; n < 35; n++) {
			const next = {}
			current.next = next
			current = next
		}
		expect(() => claudeJson(deep)).toThrow('too large')
	})
})
