import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	ACPServer,
	ACP_PERMISSION_CAPABILITY,
	type AcpSessionUpdate,
	HostCommandRegistry,
	type MCPJsonRpcMessage,
	type MCPTransport,
	type QueryParams,
	type SessionEvent,
	type ToolInputError,
	type ToolUseId,
	WriteFileTool,
	createAssistantMessage,
	generateTurnId,
	query,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { createAgentSession } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime, resolveAcpSession } from '../acp.js'
import type { CommandContext } from '../types.js'

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return { ...actual, query: vi.fn() }
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

/** Responses settle from actual transport delivery, without clock races or polling. */
function wirePair() {
	const sent: MCPJsonRpcMessage[] = []
	const replies = new Map<string | number, ReturnType<typeof deferred<MCPJsonRpcMessage>>>()
	let handler: ((message: MCPJsonRpcMessage) => void) | undefined
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		send: async (message) => {
			sent.push(message)
			if (message.id !== undefined) replies.get(message.id)?.resolve(message)
		},
		onMessage: (next) => {
			handler = next
		},
		onClose: () => {},
		onError: () => {},
		isConnected: () => true,
	}
	return {
		transport,
		sent,
		request(id: number, method: string, params: Record<string, unknown>) {
			if (!handler) throw new Error('The ACP server has not connected')
			const reply = deferred<MCPJsonRpcMessage>()
			replies.set(id, reply)
			handler({ jsonrpc: '2.0', id, method, params })
			return reply.promise
		},
	}
}

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	for (const root of roots.splice(0)) removeTempDir(root)
})

describe('an unreadable write on the CLI ACP wire', () => {
	it.each(['malformed', 'truncated'] as const)(
		'closes a %s call as failed, delivers its retry and keeps the session usable',
		async (reason) => {
			const cwd = mkdtempSync(join(tmpdir(), 'namzu-acp-unreadable-write-'))
			roots.push(cwd)
			const failure = `The write arguments were ${reason}; the tool was not executed.`
			const inputError: ToolInputError = {
				reason,
				finishReason: reason === 'truncated' ? 'length' : 'tool_calls',
				parseError: 'Unexpected end of JSON input',
				length: 12,
				precedingLength: 0,
			}
			const badId = 'call_bad_write' as ToolUseId
			const retryId = 'call_retry_write' as ToolUseId
			const rawEvents: SessionEvent[] = []
			let turns = 0
			vi.mocked(query).mockImplementation((params: QueryParams) => {
				const firstTurn = turns++ === 0
				return (async function* () {
					const envelope = {
						sessionId: params.sessionId,
						turnId: params.turnId ?? generateTurnId(),
					}
					// The executor emits a synthetic start/end for unreadable input.
					// Exercise those real host projections with the composed builtin,
					// whose presentCall({}) returns an invalid undefined label.
					if (firstTurn) {
						const events = [
							{
								type: 'tool_input_completed',
								...envelope,
								toolUseId: badId,
								input: {},
								inputTruncated: true,
								inputError,
								partialArguments: '{"content":',
							},
							{
								type: 'tool_executing',
								...envelope,
								toolUseId: badId,
								toolName: 'write',
								input: {},
							},
							{
								type: 'tool_completed',
								...envelope,
								toolUseId: badId,
								toolName: 'write',
								isError: true,
								result: failure,
							},
							{
								type: 'tool_executing',
								...envelope,
								toolUseId: retryId,
								toolName: 'write',
								input: { path: 'retry.md', content: 'A bounded retry.' },
							},
							{
								type: 'tool_completed',
								...envelope,
								toolUseId: retryId,
								toolName: 'write',
								isError: false,
								result: 'Created retry.md',
							},
						] as SessionEvent[]
						for (const event of events) yield event
					}
					yield {
						type: 'turn_completed',
						...envelope,
						stopReason: 'end_turn',
						result: firstTurn
							? 'Recovered from the unreadable write.'
							: 'The next prompt completed.',
					} as SessionEvent
					return { messages: [...(params.messages ?? []), createAssistantMessage('done')] }
				})() as ReturnType<typeof query>
			})
			vi.stubGlobal(
				'fetch',
				vi.fn(() => {
					throw new Error('This test must not make a network request')
				}),
			)
			const presentCall = vi.spyOn(WriteFileTool, 'presentCall')
			const preferences: Preferences = {
				version: 3,
				providers: [{ id: 'anthropic' }],
				subagents: { active: [] },
			}
			const detected: DetectedProvider[] = [
				{
					entry: PROVIDER_REGISTRY['anthropic'],
					source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
					apiKey: 'not-a-real-key',
					alternatives: [],
				},
			]
			const context: CommandContext = {
				config: {},
				formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
			}
			const dependencies: AcpRuntimeDependencies = {
				probe: async () => ({
					preferences,
					detected,
					needsRepickReason: null,
					credentialGap: null,
				}),
				createSession: (prefs, providers, options = {}) =>
					createAgentSession(prefs, providers, {
						...options,
						stateRoot: join(cwd, 'state'),
						sandbox: { enabled: false },
						onSessionEvent: (event) => {
							rawEvents.push(event)
							options.onSessionEvent?.(event)
						},
					}),
				decideTrust: ({ cwd }) => ({ allowed: true, cwd }),
				resolveProjectContext: (ctx) => ctx,
				resolveSession: (id) => resolveAcpSession(id, async () => undefined),
			}
			const runtime = createCliAcpRuntime(context, dependencies)
			const wire = wirePair()
			const server = new ACPServer({
				transport: wire.transport,
				gateway: runtime.gateway,
				presenter: runtime.presenter,
				commands: new HostCommandRegistry(),
				agentInfo: { name: 'namzu', version: 'test' },
				newSessionId: () => 'unreadable-write-session',
			})
			try {
				await server.start()
				await wire.request(1, 'initialize', { capabilities: [ACP_PERMISSION_CAPABILITY] })
				expect((await wire.request(2, 'session/new', { cwd })).result).toEqual({
					sessionId: 'unreadable-write-session',
				})
				const first = await wire.request(3, 'session/prompt', {
					sessionId: 'unreadable-write-session',
					prompt: 'Write a report.',
				})
				// The server drains admitted updates before replying to a prompt.
				const updates = wire.sent
					.filter((frame) => frame.method === 'session/update')
					.map((frame) => (frame.params as { update: AcpSessionUpdate }).update)
				expect(updates.filter((update) => update.kind === 'tool_call')).toMatchObject([
					{ toolCallId: badId, status: 'pending', view: { kind: 'generic', label: 'write' } },
					{ toolCallId: badId, status: 'failed', view: { kind: 'generic', label: failure } },
					{ toolCallId: retryId, status: 'pending', view: { kind: 'generic', label: 'retry.md' } },
					{ toolCallId: retryId, status: 'completed' },
				])
				expect(updates.at(-1)).toMatchObject({ kind: 'turn_ended', stopReason: 'end_turn' })
				expect(first.result).toEqual({ stopReason: 'end_turn', reason: 'end_turn' })
				expect(first.error).toBeUndefined()
				expect(rawEvents.find((event) => event.type === 'tool_input_completed')).toMatchObject({
					input: {},
					inputError,
				})
				expect(presentCall).toHaveBeenCalledWith({})
				expect(presentCall).toHaveBeenCalledWith({ path: 'retry.md', content: 'A bounded retry.' })

				const second = await wire.request(4, 'session/prompt', {
					sessionId: 'unreadable-write-session',
					prompt: 'Continue with the next task.',
				})
				expect(second.result).toEqual({ stopReason: 'end_turn', reason: 'end_turn' })
				expect(second.error).toBeUndefined()
				expect(turns).toBe(2)
			} finally {
				await server.stop()
				await runtime.close()
			}
		},
	)
})
