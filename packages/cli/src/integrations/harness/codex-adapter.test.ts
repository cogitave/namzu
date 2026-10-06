import {
	type HarnessEvent,
	type HarnessPrompt,
	type HarnessReviewRequest,
	InMemorySessionLog,
	type SessionEvent,
	createHarnessSession,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexHarnessAdapter, discoverCodexHarnessModels } from './codex-adapter.js'

const fixture = vi.hoisted(() => ({
	frames: [] as Record<string, unknown>[],
	emit: undefined as undefined | ((frame: unknown) => Promise<void>),
	onWrite: undefined as
		| undefined
		| ((
				frame: Record<string, unknown>,
				emit: (frame: unknown) => Promise<void>,
		  ) => Promise<boolean>),
	close: vi.fn(),
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs/promises')>()),
	realpath: async (path: string) => path,
}))
vi.mock('./native-executable.js', () => ({
	resolveHarnessExecutable: async () => '/native/codex',
}))
vi.mock('./process.js', () => ({
	startHarnessProcess: (
		_command: unknown,
		options: {
			onFrame: (frame: unknown) => Promise<void>
			onClosed: () => Promise<void>
		},
	) => {
		fixture.emit = options.onFrame
		return {
			closed: Promise.resolve(),
			close: async () => {
				fixture.close()
				await options.onClosed()
				return { stopped: true }
			},
			write: async (raw: unknown) => {
				const frame = raw as Record<string, unknown>
				fixture.frames.push(frame)
				if (await fixture.onWrite?.(frame, options.onFrame)) return
				if (frame.id === undefined || typeof frame.method !== 'string') return
				const params = frame.params as Record<string, unknown>
				let result: unknown = {}
				if (frame.method === 'account/read')
					result = { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }
				if (frame.method === 'model/list')
					result = {
						data: [
							{
								id: 'row-id',
								model: 'native-model',
								isDefault: true,
								supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
								defaultReasoningEffort: 'high',
							},
						],
						nextCursor: null,
					}
				if (frame.method === 'thread/start' || frame.method === 'thread/resume')
					result = {
						model: params.model,
						thread: {
							id: 'native/thread:not-namzu-uuid',
							cwd: params.cwd,
							status: { type: 'idle' },
						},
					}
				if (frame.method === 'turn/start') {
					await options.onFrame({
						method: 'turn/started',
						params: {
							threadId: 'native/thread:not-namzu-uuid',
							turn: { id: 'turn-1', status: 'inProgress' },
						},
					})
					result = { turn: { id: 'turn-1', status: 'inProgress' } }
				}
				await options.onFrame({ id: frame.id, result })
			},
		}
	},
}))

const prompt: HarnessPrompt = {
	operationId: 'host-operation',
	prompt: 'Hello',
	model: 'native-model',
	effort: 'high',
	permissionMode: 'prompt',
}
beforeEach(() => {
	fixture.frames.length = 0
	fixture.emit = undefined
	fixture.onWrite = undefined
	fixture.close.mockClear()
})

async function open() {
	const events: HarnessEvent[] = []
	const adapter = await createCodexHarnessAdapter({
		profileRef: 'native-profile',
	})
	const connection = await adapter.open({ cwd: '/workspace' }, async (event) => {
		events.push(event)
	})
	return { adapter, connection, events }
}

function nativeEffortCatalogue() {
	fixture.onWrite = async (frame, emit) => {
		if (frame.method !== 'model/list') return false
		await emit({
			id: frame.id,
			result: {
				data: [
					{
						model: 'native-model',
						isDefault: true,
						supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
						defaultReasoningEffort: 'high',
					},
					{
						model: 'other-native-model',
						supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
						defaultReasoningEffort: 'medium',
					},
				],
				nextCursor: null,
			},
		})
		return true
	}
}

async function sdkEffortSession() {
	const scope = {
		sessionId: generateSessionId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		cwd: '/workspace',
	}
	const log = new InMemorySessionLog({ sessionId: scope.sessionId })
	const adapter = await createCodexHarnessAdapter({ profileRef: 'sdk-effort-profile' })
	const session = createHarnessSession({
		scope,
		sessionLog: log,
		adapter,
		assertAdmission: async () => undefined,
		onEvent: () => undefined,
		onReview: () => undefined,
	})
	return { session, log }
}

describe('Codex owned external engine adapter', () => {
	it('admits UI-discovered explicit efforts through the real SDK run and sends the chosen model and effort', async () => {
		nativeEffortCatalogue()
		const discovered = await discoverCodexHarnessModels({ cwd: '/workspace' })
		expect(discovered.map((model) => model.effortLevels)).toEqual([['high'], ['medium']])
		const discovery = fixture.onWrite!
		let sequence = 0
		fixture.onWrite = async (frame, emit) => {
			if (await discovery(frame, emit)) return true
			if (frame.method !== 'turn/start') return false
			const params = frame.params as Record<string, unknown>
			const turn = { id: `sdk-effort-turn-${++sequence}`, status: 'completed' }
			await emit({
				method: 'item/completed',
				params: {
					threadId: params.threadId,
					turnId: turn.id,
					item: {
						type: 'agentMessage',
						id: `sdk-effort-answer-${sequence}`,
						text: 'Explicit effort accepted.',
						phase: 'final_answer',
					},
				},
			})
			await emit({ method: 'turn/completed', params: { threadId: params.threadId, turn } })
			await emit({ id: frame.id, result: { turn } })
			return true
		}
		const { session, log } = await sdkEffortSession()
		try {
			await expect(
				session.run({
					prompt: 'Refuse unoffered effort.',
					model: 'native-model',
					effort: 'xhigh',
					permissionMode: 'prompt',
				}),
			).rejects.toThrow('does not support the selected effort')
			expect(fixture.frames.filter((frame) => frame.method === 'turn/start')).toEqual([])
			expect(
				(await log.readAll()).entries.some(({ record }) => record.type === 'turn_started'),
			).toBe(false)
			for (const model of discovered) {
				const effort = model.effortLevels?.[0]
				if (!effort) throw new Error('Fixture model must offer its actual effort.')
				expect(
					await session.run({
						prompt: 'Use the UI-selected effort.',
						model: model.id,
						effort,
						permissionMode: 'prompt',
					}),
				).toMatchObject({ status: 'completed' })
			}
			expect(
				fixture.frames
					.filter((frame) => frame.method === 'turn/start')
					.map((frame) => frame.params),
			).toEqual([
				expect.objectContaining({ model: 'native-model', effort: 'high' }),
				expect.objectContaining({ model: 'other-native-model', effort: 'medium' }),
			])
		} finally {
			await session.close()
		}
	})
	it('retains fresh per-model refusal when another discovered model offers the explicit effort', async () => {
		nativeEffortCatalogue()
		const { session } = await sdkEffortSession()
		try {
			await expect(
				session.run({
					prompt: 'Refuse another model’s effort.',
					model: 'native-model',
					effort: 'medium',
					permissionMode: 'prompt',
				}),
			).rejects.toThrow('selected Codex model or effort is unavailable')
			expect(fixture.frames.filter((frame) => frame.method === 'turn/start')).toEqual([])
		} finally {
			await session.close()
		}
	})
	it('resets persistent native effort to the selected model default, including after a model change', async () => {
		const effective: { model: unknown; effort: unknown }[] = []
		let retainedEffort: unknown
		fixture.onWrite = async (frame, emit) => {
			if (frame.method === 'model/list') {
				await emit({
					id: frame.id,
					result: {
						data: [
							{
								model: 'native-model',
								isDefault: true,
								supportedReasoningEfforts: [
									{ reasoningEffort: 'low' },
									{ reasoningEffort: 'high' },
								],
								defaultReasoningEffort: 'low',
							},
							{
								model: 'other-native-model',
								supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
								defaultReasoningEffort: 'medium',
							},
						],
						nextCursor: null,
					},
				})
				return true
			}
			if (frame.method !== 'turn/start') return false
			const params = frame.params as Record<string, unknown>
			if (params.effort !== undefined) retainedEffort = params.effort
			effective.push({ model: params.model, effort: retainedEffort })
			const turn = { id: `effort-turn-${effective.length}`, status: 'completed' }
			await emit({
				method: 'turn/completed',
				params: { threadId: params.threadId, turn },
			})
			await emit({ id: frame.id, result: { turn } })
			return true
		}
		const { connection } = await open()
		try {
			await connection.dispatch(prompt)
			await connection.dispatch({ ...prompt, operationId: 'default-operation', effort: undefined })
			await connection.dispatch({
				...prompt,
				operationId: 'different-model-operation',
				model: 'other-native-model',
				effort: undefined,
			})
			expect(effective).toEqual([
				{ model: 'native-model', effort: 'high' },
				{ model: 'native-model', effort: 'low' },
				{ model: 'other-native-model', effort: 'medium' },
			])
		} finally {
			await connection.close()
		}
	})
	it.each([undefined, 'unsupported', 'low'])(
		'refuses unknown or unoffered default effort %s before dispatch while allowing an explicit offered effort',
		async (defaultReasoningEffort) => {
			fixture.onWrite = async (frame, emit) => {
				if (frame.method !== 'model/list') return false
				await emit({
					id: frame.id,
					result: {
						data: [
							{
								model: 'native-model',
								isDefault: true,
								supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
								defaultReasoningEffort,
							},
						],
						nextCursor: null,
					},
				})
				return true
			}
			const { connection } = await open()
			try {
				await expect(connection.dispatch({ ...prompt, effort: undefined })).rejects.toThrow(
					'does not report a default reasoning effort',
				)
				expect(fixture.frames.filter((frame) => frame.method === 'turn/start')).toHaveLength(0)
				await connection.dispatch(prompt)
				expect(fixture.frames.filter((frame) => frame.method === 'turn/start')).toEqual([
					expect.objectContaining({ params: expect.objectContaining({ effort: 'high' }) }),
				])
			} finally {
				await connection.close()
			}
		},
	)
	it('projects native reviews and tools through the actual SDK journal without Namzu inference', async () => {
		const scope = {
			sessionId: generateSessionId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			topicId: generateTopicId(),
			cwd: '/workspace',
		}
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })
		const published: SessionEvent[] = []
		let present!: (review: HarnessReviewRequest) => void
		const reviewed = new Promise<HarnessReviewRequest>((resolve) => {
			present = resolve
		})
		const adapter = await createCodexHarnessAdapter({ profileRef: 'sdk-owned-profile' })
		const session = createHarnessSession({
			scope,
			sessionLog: log,
			adapter,
			assertAdmission: async () => undefined,
			onEvent: (event) => {
				published.push(event)
			},
			onReview: present,
		})
		const threadId = 'native/thread:not-namzu-uuid'
		const nativeTurnId = 'sdk-native-turn'
		fixture.onWrite = async (frame, emit) => {
			if (frame.method !== 'turn/start') return false
			await emit({
				method: 'turn/started',
				params: { threadId, turn: { id: nativeTurnId, status: 'inProgress' } },
			})
			await emit({
				method: 'item/started',
				params: {
					threadId,
					turnId: nativeTurnId,
					item: { type: 'commandExecution', id: 'sdk-command', command: 'literal', cwd: scope.cwd },
				},
			})
			await emit({
				id: 'sdk-review',
				method: 'item/commandExecution/requestApproval',
				params: {
					threadId,
					turnId: nativeTurnId,
					itemId: 'sdk-command',
					command: 'literal',
					cwd: scope.cwd,
				},
			})
			await emit({ id: frame.id, result: { turn: { id: nativeTurnId, status: 'inProgress' } } })
			return true
		}
		try {
			const outcome = session.run({
				prompt: 'Check the command',
				model: 'native-model',
				permissionMode: 'prompt',
			})
			const review = await reviewed
			expect(review.input).toEqual({ command: 'literal', cwd: scope.cwd })
			await session.respond(review, { kind: 'reject', feedback: 'Use a different command.' })
			expect(fixture.frames.at(-1)).toEqual({ id: 'sdk-review', result: { decision: 'decline' } })
			await fixture.emit?.({
				method: 'item/agentMessage/delta',
				params: {
					threadId,
					turnId: nativeTurnId,
					itemId: 'sdk-answer',
					delta: 'Command ',
				},
			})
			await fixture.emit?.({
				method: 'item/agentMessage/delta',
				params: {
					threadId,
					turnId: nativeTurnId,
					itemId: 'sdk-answer',
					delta: 'declined.',
				},
			})
			await fixture.emit?.({
				method: 'item/completed',
				params: {
					threadId,
					turnId: nativeTurnId,
					item: {
						type: 'commandExecution',
						id: 'sdk-command',
						status: 'declined',
						aggregatedOutput: '',
					},
				},
			})
			await fixture.emit?.({
				method: 'item/completed',
				params: {
					threadId,
					turnId: nativeTurnId,
					item: {
						type: 'agentMessage',
						id: 'sdk-answer',
						text: 'Command declined.',
						phase: 'final_answer',
					},
				},
			})
			await fixture.emit?.({
				method: 'turn/completed',
				params: { threadId, turn: { id: nativeTurnId, status: 'completed' } },
			})
			expect((await outcome).status).toBe('completed')
			const completedMessage = published.find((event) => event.type === 'message_completed')
			expect(completedMessage).toMatchObject({ content: 'Command declined.' })
			if (completedMessage?.type !== 'message_completed')
				throw new Error('Expected the completed native assistant message.')
			expect(published).toContainEqual(
				expect.objectContaining({
					type: 'turn_completed',
					result: 'Command declined.',
					settlement: expect.objectContaining({
						resultMessageId: completedMessage.messageId,
					}),
				}),
			)
			expect(published).toContainEqual(
				expect.objectContaining({
					type: 'tool_executing',
					toolName: 'codex:exec_command',
					input: { command: 'literal', cwd: scope.cwd },
				}),
			)
			expect(published).toContainEqual(
				expect.objectContaining({
					type: 'tool_completed',
					toolName: 'codex:exec_command',
					isError: true,
				}),
			)
			const records = (await log.readAll()).entries.map((entry) => entry.record)
			expect(records).toContainEqual(
				expect.objectContaining({
					type: 'session_updated',
					harness: expect.objectContaining({
						kind: 'review-decided',
						requestId: 'codex:["string","sdk-review"]',
					}),
				}),
			)
			expect(
				records.filter((record) => record.type === 'message' && record.role === 'assistant'),
			).toHaveLength(1)
			expect(
				(await session.history()).some(
					(message) => message.role === 'assistant' && message.content === 'Command declined.',
				),
			).toBe(true)
		} finally {
			await session.close()
		}
	})
	it.each([
		{
			label: 'explicit final answer followed by commentary',
			items: [
				{ id: 'final', text: 'Actual answer', phase: 'final_answer' },
				{ id: 'commentary', text: 'Progress only', phase: 'commentary' },
			],
			finalItemId: 'final',
		},
		{
			label: 'older unphased completed assistant',
			items: [
				{ id: 'commentary', text: 'Progress only', phase: 'commentary' },
				{ id: 'final', text: 'Actual answer', phase: null },
			],
			finalItemId: 'final',
		},
		{
			label: 'explicit final answer followed by unphased text',
			items: [
				{ id: 'final', text: 'Actual answer', phase: 'final_answer' },
				{ id: 'unphased', text: 'Additional text', phase: null },
			],
			finalItemId: 'final',
		},
		{
			label: 'commentary without an answer',
			items: [{ id: 'commentary', text: 'Progress only', phase: 'commentary' }],
			finalItemId: undefined,
		},
		{
			label: 'authoritative empty final answer',
			items: [{ id: 'empty', text: '', phase: 'final_answer' }],
			finalItemId: 'empty',
		},
	])(
		'binds terminal identity to $label, excluding foreign turns and partial text',
		async ({ items, finalItemId }) => {
			const { connection, events } = await open()
			try {
				const turn = await connection.dispatch(prompt)
				await fixture.emit?.({
					method: 'item/completed',
					params: {
						threadId: turn.nativeSessionId,
						turnId: 'foreign-turn',
						item: { type: 'agentMessage', id: 'foreign', text: 'Foreign', phase: 'final_answer' },
					},
				})
				for (const item of items)
					await fixture.emit?.({
						method: 'item/completed',
						params: {
							threadId: turn.nativeSessionId,
							turnId: turn.nativeTurnId,
							item: { type: 'agentMessage', ...item },
						},
					})
				await fixture.emit?.({
					method: 'item/agentMessage/delta',
					params: {
						threadId: turn.nativeSessionId,
						turnId: turn.nativeTurnId,
						itemId: 'unfinished',
						delta: 'Uncompleted stream',
					},
				})
				await fixture.emit?.({
					method: 'turn/completed',
					params: {
						threadId: turn.nativeSessionId,
						turn: { id: turn.nativeTurnId, status: 'completed' },
					},
				})
				expect(events.at(-1)).toEqual({
					...turn,
					kind: 'turn-completed',
					status: 'completed',
					...(finalItemId ? { finalItemId } : {}),
				})
			} finally {
				await connection.close()
			}
		},
	)
	it('keeps an unacknowledged sent prompt uncertain instead of admitting a second native turn', async () => {
		const { connection } = await open()
		let sent!: () => void
		const sentRequest = new Promise<void>((resolve) => {
			sent = resolve
		})
		fixture.onWrite = async (frame) => {
			if (frame.method !== 'turn/start') return false
			sent()
			return true
		}
		const abort = new AbortController()
		const dispatch = connection.dispatch({ ...prompt, signal: abort.signal })
		const rejected = expect(dispatch).rejects.toThrow('explicit cancellation')
		await sentRequest
		abort.abort(new Error('explicit cancellation'))
		await rejected
		await expect(connection.dispatch(prompt)).rejects.toThrow('active or unresolved')
		expect(fixture.frames.filter((frame) => frame.method === 'turn/start')).toHaveLength(1)
		await connection.close()
	})
	it('refuses signed-out metadata and cyclic pagination without publishing invented models', async () => {
		fixture.onWrite = async (frame, emit) => {
			if (frame.method !== 'account/read') return false
			await emit({
				id: frame.id,
				result: { account: null, requiresOpenaiAuth: true },
			})
			return true
		}
		await expect(discoverCodexHarnessModels({ cwd: '/workspace' })).rejects.toThrow(
			'own signed-in account',
		)
		fixture.onWrite = async (frame, emit) => {
			if (frame.method !== 'model/list') return false
			await emit({
				id: frame.id,
				result: { data: [{ model: 'real-model' }], nextCursor: 'repeated' },
			})
			return true
		}
		await expect(discoverCodexHarnessModels({ cwd: '/workspace' })).rejects.toThrow(
			'repeated a model pagination',
		)
	})
	it('does not claim complete resumed history when native pending approval cannot be reconstructed', async () => {
		const first = await open()
		const binding = first.connection.binding
		await first.connection.close()
		fixture.onWrite = async (frame, emit) => {
			let result: unknown
			if (frame.method === 'thread/read')
				result = {
					thread: {
						id: binding.nativeSessionId,
						cwd: binding.cwd,
						status: { type: 'active', activeFlags: ['waitingOnApproval'] },
					},
				}
			if (frame.method === 'thread/turns/list')
				result = {
					data: [{ id: 'active-native-turn', status: 'inProgress' }],
					nextCursor: null,
				}
			if (frame.method === 'thread/items/list') result = { data: [], nextCursor: null }
			if (result === undefined) return false
			await emit({ id: frame.id, result })
			return true
		}
		const resumed = await first.adapter.open(
			{ cwd: '/workspace', resume: binding },
			async () => undefined,
		)
		expect(await resumed.readHistory()).toMatchObject({
			complete: false,
			pendingReviews: [],
			activeTurn: { nativeTurnId: 'active-native-turn' },
		})
		await expect(resumed.dispatch(prompt)).rejects.toThrow('active or unresolved')
		await resumed.close()
	})
	it('discovers all model pages without creating a conversation or calling Namzu inference', async () => {
		fixture.onWrite = async (frame, emit) => {
			if (frame.method !== 'model/list') return false
			const params = frame.params as Record<string, unknown>
			await emit({
				id: frame.id,
				result: params.cursor
					? {
							data: [{ model: 'native-default', isDefault: true }],
							nextCursor: null,
						}
					: { data: [{ model: 'native-other' }], nextCursor: 'cursor-2' },
			})
			return true
		}
		expect(
			(await discoverCodexHarnessModels({ cwd: '/workspace' })).map((model) => model.id),
		).toEqual(['native-default', 'native-other'])
		expect(fixture.frames.map((frame) => frame.method)).toEqual([
			'initialize',
			'initialized',
			'account/read',
			'model/list',
			'model/list',
		])
		expect(fixture.close).toHaveBeenCalledOnce()
	})
	it('does not resurrect an early terminal turn when start ACK or replay arrives later', async () => {
		const { connection, events } = await open()
		fixture.onWrite = async (frame, emit) => {
			if (frame.method !== 'turn/start') return false
			const identity = {
				threadId: connection.binding.nativeSessionId,
				turnId: 'early-turn',
			}
			await emit({
				method: 'turn/started',
				params: {
					threadId: identity.threadId,
					turn: { id: 'early-turn', status: 'inProgress' },
				},
			})
			await emit({
				method: 'item/agentMessage/delta',
				params: { ...identity, itemId: 'answer', delta: 'Hello' },
			})
			await emit({
				method: 'item/completed',
				params: {
					...identity,
					item: {
						type: 'agentMessage',
						id: 'answer',
						text: 'Hello',
						phase: 'final_answer',
					},
				},
			})
			await emit({
				method: 'turn/completed',
				params: {
					threadId: identity.threadId,
					turn: { id: 'early-turn', status: 'completed' },
				},
			})
			await emit({
				id: frame.id,
				result: { turn: { id: 'early-turn', status: 'completed' } },
			})
			return true
		}
		expect(await connection.dispatch(prompt)).toEqual({
			nativeSessionId: connection.binding.nativeSessionId,
			nativeTurnId: 'early-turn',
		})
		await fixture.emit?.({
			method: 'turn/started',
			params: {
				threadId: connection.binding.nativeSessionId,
				turn: { id: 'early-turn' },
			},
		})
		expect(events.filter((event) => event.kind === 'message-completed')).toHaveLength(1)
		expect(events.filter((event) => event.kind === 'turn-started')).toHaveLength(1)
		await expect(
			connection.dispatch({
				...prompt,
				effort: 'unsupported' as HarnessPrompt['effort'],
			}),
		).rejects.toThrow('unavailable')
		await connection.close()
	})
	it('keeps Stop receipt separate from terminal confirmation and refuses concurrent/stale turns', async () => {
		const { connection, events } = await open()
		const turn = await connection.dispatch(prompt)
		expect(await connection.interrupt(turn)).toEqual({ requested: true })
		expect(events.some((event) => event.kind === 'turn-completed')).toBe(false)
		await expect(connection.dispatch(prompt)).rejects.toThrow('active or unresolved')
		await fixture.emit?.({
			method: 'turn/completed',
			params: {
				threadId: turn.nativeSessionId,
				turn: { id: turn.nativeTurnId, status: 'interrupted' },
			},
		})
		expect(events.at(-1)).toMatchObject({
			kind: 'turn-completed',
			status: 'cancelled',
		})
		await expect(connection.interrupt(turn)).rejects.toThrow('no longer')
		await connection.close()
	})
	it('routes typed opaque approval IDs once and refuses changed or terminal requests', async () => {
		const { connection, events } = await open()
		const turn = await connection.dispatch(prompt)
		for (const id of [41, '41'])
			await fixture.emit?.({
				id,
				method: 'item/commandExecution/requestApproval',
				params: {
					threadId: turn.nativeSessionId,
					turnId: turn.nativeTurnId,
					itemId: 'same-command',
					command: 'literal command',
					cwd: '/workspace',
				},
			})
		const reviews = events.flatMap((event) =>
			event.kind === 'review-requested' ? [event.request] : [],
		)
		expect(reviews).toHaveLength(2)
		expect(reviews[0]?.requestId).not.toBe(reviews[1]?.requestId)
		const [first, second] = reviews
		if (!first || !second) throw new Error('Expected both native approval requests.')
		await expect(
			connection.respond({ ...first, input: { command: 'changed' } }, { kind: 'approve-once' }),
		).rejects.toThrow('stale or changed')
		await connection.respond(first, { kind: 'approve-once' })
		expect(fixture.frames.at(-1)).toEqual({
			id: 41,
			result: { decision: 'accept' },
		})
		await expect(connection.respond(first, { kind: 'approve-once' })).rejects.toThrow(
			'stale or changed',
		)
		await fixture.emit?.({
			method: 'turn/completed',
			params: {
				threadId: turn.nativeSessionId,
				turn: { id: turn.nativeTurnId, status: 'completed' },
			},
		})
		await expect(connection.respond(second, { kind: 'approve-once' })).rejects.toThrow(
			'stale or changed',
		)
		await connection.close()
	})
	it('returns method-not-found for unsupported server requests instead of inventing success', async () => {
		const { connection } = await open()
		await fixture.emit?.({
			id: 'unknown-request',
			method: 'future/unsupported',
			params: {},
		})
		expect(fixture.frames.at(-1)).toEqual({
			id: 'unknown-request',
			error: {
				code: -32601,
				message: 'This Codex request is unsupported by Namzu.',
			},
		})
		await connection.close()
	})
	it('settles native questions without an approvable permission request or invented answers', async () => {
		const { connection, events } = await open()
		const turn = await connection.dispatch(prompt)
		await fixture.emit?.({
			id: 'question-request',
			method: 'item/tool/requestUserInput',
			params: {
				threadId: turn.nativeSessionId,
				turnId: turn.nativeTurnId,
				itemId: 'native-question-item',
				questions: [{ id: 'choice', question: 'Which branch?', options: [] }],
			},
		})
		expect(fixture.frames.at(-1)).toEqual({
			id: 'question-request',
			result: { answers: {} },
		})
		expect(events.some((event) => event.kind === 'review-requested')).toBe(false)
		expect(events.at(-1)).toMatchObject({
			kind: 'tool-completed',
			name: 'request_user_input',
			status: 'declined',
			result: 'Answer this question in the conversation.',
		})
		await expect(connection.dispatch(prompt)).rejects.toThrow('active or unresolved')
		await connection.close()
	})
	it('resumes exact native identity and paginated history; foreign profile or cwd are refused', async () => {
		const first = await open()
		const binding = first.connection.binding
		await first.connection.close()
		fixture.onWrite = async (frame, emit) => {
			let result: unknown
			if (frame.method === 'thread/read')
				result = {
					thread: {
						id: binding.nativeSessionId,
						cwd: binding.cwd,
						status: { type: 'idle' },
					},
				}
			if (frame.method === 'thread/turns/list')
				result = {
					data: [{ id: 'historic-turn', status: 'completed' }],
					nextCursor: null,
				}
			if (frame.method === 'thread/items/list')
				result = {
					data: [
						{
							turnId: 'historic-turn',
							item: {
								type: 'agentMessage',
								id: 'historic-answer',
								text: 'Saved answer',
								phase: 'final_answer',
							},
						},
					],
					nextCursor: null,
				}
			if (result === undefined) return false
			await emit({ id: frame.id, result })
			return true
		}
		const resumed = await first.adapter.open(
			{ cwd: '/workspace', resume: binding },
			async () => undefined,
		)
		expect(resumed.binding).toEqual(binding)
		expect(fixture.frames.find((frame) => frame.method === 'thread/resume')?.params).toMatchObject({
			threadId: binding.nativeSessionId,
			excludeTurns: true,
		})
		const history = await resumed.readHistory()
		expect(history.events).toContainEqual(
			expect.objectContaining({
				kind: 'message-completed',
				nativeItemId: 'historic-answer',
				content: 'Saved answer',
			}),
		)
		expect(history.events).toContainEqual({
			kind: 'turn-completed',
			nativeSessionId: binding.nativeSessionId,
			nativeTurnId: 'historic-turn',
			status: 'completed',
			finalItemId: 'historic-answer',
		})
		await resumed.close()
		await expect(
			first.adapter.open(
				{ cwd: '/workspace', resume: { ...binding, profileRef: 'foreign' } },
				async () => undefined,
			),
		).rejects.toThrow('does not belong')
		await expect(
			first.adapter.open({ cwd: '/other', resume: binding }, async () => undefined),
		).rejects.toThrow('does not belong')
	})
})
