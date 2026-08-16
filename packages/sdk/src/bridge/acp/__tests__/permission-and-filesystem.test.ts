import { describe, expect, it } from 'vitest'

import { ACP_CLIENT_REQUESTS, ACP_PERMISSION_CAPABILITY } from '../../../constants/acp/index.js'
import { HostCommandRegistry } from '../../../registry/command/index.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { fixtureId } from '../../../test-support/ids.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import type { Sandbox } from '../../../types/sandbox/index.js'
import { clientBackedSandbox } from '../filesystem.js'
import { ACP_DEFAULT_REJECTION, toResumeDecision } from '../permission.js'
import { ACPServer, type AcpAgentGateway } from '../server.js'

/**
 * The half that makes the bridge usable for the case it exists for: an
 * editor driving an agent that edits files.
 *
 * Three exchanges, each with a failure mode that is silent:
 *
 *  - a permission request that auto-approves instead of asking;
 *  - an "approve all" that leaks past the session that granted it;
 *  - a filesystem read that falls back to disk while the user has unsaved
 *    changes, so the model patches text nobody is looking at.
 */

const CAPS = [ACP_PERMISSION_CAPABILITY, 'fs']

function pair() {
	const sent: MCPJsonRpcMessage[] = []
	let handler: ((m: MCPJsonRpcMessage) => void) | undefined
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		send: async (m) => {
			sent.push(m)
		},
		onMessage: (h) => {
			handler = h
		},
		onClose: () => {},
		onError: () => {},
		isConnected: () => true,
	}
	return { sent, transport, deliver: (m: MCPJsonRpcMessage) => handler?.(m) }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/**
 * A client that answers whatever this side asks it.
 *
 * Wired as a real frame exchange rather than a stubbed method, because what
 * is under test includes the direction the bridge did not have: a request
 * with an id, parked, and resolved by a response frame.
 */
function autoAnswering(
	wire: ReturnType<typeof pair>,
	answers: Partial<Record<string, unknown>>,
	log?: { method: string; params: unknown }[],
) {
	let seen = 0
	const pump = setInterval(() => {
		for (; seen < wire.sent.length; seen++) {
			const frame = wire.sent[seen]
			if (!frame?.method || frame.id === undefined) continue
			if (!(frame.method in answers)) continue
			log?.push({ method: frame.method, params: frame.params })
			const answer = answers[frame.method]
			wire.deliver(
				answer instanceof Error
					? { jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: answer.message } }
					: { jsonrpc: '2.0', id: frame.id, result: answer },
			)
		}
	}, 1)
	return () => clearInterval(pump)
}

async function open(
	wire: ReturnType<typeof pair>,
	server: ACPServer,
	capabilities = CAPS,
): Promise<string> {
	await server.start()
	wire.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities } })
	await settle()
	wire.deliver({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
	await settle()
	return (wire.sent.find((m) => m.id === 2)?.result as { sessionId: string }).sessionId
}

describe('a tool batch that needs a human', () => {
	it('reaches the client as a permission request, and a denial comes back as reject_tools', async () => {
		const wire = pair()
		const asked: { method: string; params: unknown }[] = []
		const stop = autoAnswering(
			wire,
			{
				[ACP_CLIENT_REQUESTS.REQUEST_PERMISSION]: {
					outcome: 'reject',
					feedback: 'not against production',
				},
			},
			asked,
		)

		let decision: unknown
		const gateway: AcpAgentGateway = {
			prompt: async ({ ask, sessionId }) => {
				const outcome = await ask({
					sessionId,
					toolCalls: [
						{ id: 'toolu_1', name: 'bash', input: { command: 'rm -rf /' }, isDestructive: true },
					],
				})
				// The mapping the kernel actually consumes. A bridge that asked and
				// then dropped the answer would still pass a test that only checked
				// the request went out.
				decision = toResumeDecision(outcome, ['bash'])
				return { stopReason: 'end_turn' }
			},
		}

		const server = new ACPServer({
			transport: wire.transport,
			gateway,
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
			newSessionId: () => 'ses_one',
		})
		const sessionId = await open(wire, server)

		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId, prompt: 'clean up' },
		})
		await new Promise((resolve) => setTimeout(resolve, 40))
		stop()

		// It ASKED — a bridge that auto-approved would send nothing here.
		expect(asked).toHaveLength(1)
		expect((asked[0]?.params as { toolCalls: { name: string }[] }).toolCalls[0]?.name).toBe('bash')

		// And the denial reached the model in the vocabulary it acts on. A
		// `continue` here would run the calls the human just refused.
		expect(decision).toEqual({ action: 'reject_tools', feedback: 'not against production' })
	})

	it('carries the grant keys on approve_all, which ARE the latch', () => {
		// The bridge's own latch stops it asking the CLIENT again. `remember` is
		// the other half: it is what stops the KERNEL asking within a run, and
		// `approve_tools` with nothing remembered is indistinguishable from a
		// plain approve. Dropping the keys is how an "approve all" that never
		// takes gets shipped — mutation-checked, because nothing else here
		// would have caught it.
		expect(toResumeDecision({ kind: 'approve_all' }, ['bash', 'write_file'])).toEqual({
			action: 'approve_tools',
			remember: ['bash', 'write_file'],
		})
	})

	it('remembers NOTHING on a plain approve — consent is not transferable', () => {
		// The other direction, so the assertion above cannot be satisfied by
		// always attaching the keys: this batch was approved, and the next one
		// is a new question.
		expect(toResumeDecision({ kind: 'approve' }, ['bash'])).toEqual({ action: 'approve_tools' })
	})

	it('gives a bare denial a reason, because an empty one reads as a tool that just failed', () => {
		expect(toResumeDecision({ kind: 'reject' }, [])).toEqual({
			action: 'reject_tools',
			feedback: ACP_DEFAULT_REJECTION,
		})
		expect(toResumeDecision({ kind: 'reject', feedback: '   ' }, [])).toEqual({
			action: 'reject_tools',
			feedback: ACP_DEFAULT_REJECTION,
		})
	})

	it('treats an answer it cannot read as a refusal, never as consent', async () => {
		const wire = pair()
		const stop = autoAnswering(wire, {
			[ACP_CLIENT_REQUESTS.REQUEST_PERMISSION]: { outcome: 'maybe_later' },
		})
		let outcome: unknown
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				prompt: async ({ ask, sessionId }) => {
					outcome = await ask({ sessionId, toolCalls: [] })
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
			newSessionId: () => 'ses_one',
		})
		const sessionId = await open(wire, server)
		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId, prompt: 'go' },
		})
		await new Promise((resolve) => setTimeout(resolve, 40))
		stop()

		// A client that sent something unrecognised has NOT said yes.
		expect(outcome).toMatchObject({ kind: 'reject' })
	})
})

describe('approve all', () => {
	it('latches for the session that granted it, and NOT for the next one', async () => {
		const wire = pair()
		const asked: { method: string; params: unknown }[] = []
		const stop = autoAnswering(
			wire,
			{ [ACP_CLIENT_REQUESTS.REQUEST_PERMISSION]: { outcome: 'approve_all' } },
			asked,
		)

		let seq = 0
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				prompt: async ({ ask, sessionId }) => {
					await ask({ sessionId, toolCalls: [] })
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
			newSessionId: () => `ses_${++seq}`,
		})
		const first = await open(wire, server)

		const prompt = async (id: number, sessionId: string) => {
			wire.deliver({
				jsonrpc: '2.0',
				id,
				method: 'session/prompt',
				params: { sessionId, prompt: 'go' },
			})
			await new Promise((resolve) => setTimeout(resolve, 30))
		}

		await prompt(3, first)
		expect(asked).toHaveLength(1)
		await prompt(4, first)
		// Latched: the second batch in the SAME session is not asked about.
		expect(asked).toHaveLength(1)

		wire.deliver({ jsonrpc: '2.0', id: 5, method: 'session/new', params: {} })
		await settle()
		const second = (wire.sent.find((m) => m.id === 5)?.result as { sessionId: string }).sessionId
		expect(second).not.toBe(first)

		await prompt(6, second)
		stop()

		// A NEW session asks again. Hoisting the latch to the server — or to a
		// module-level variable — would make one person's "stop asking me"
		// cover the next session this process serves, which may be a different
		// repository, editor window, or human.
		expect(asked).toHaveLength(2)
	})
})

describe("the client's buffers as the filesystem", () => {
	function diskSandbox(contents: string): Sandbox {
		return {
			id: fixtureId.sandbox('disk'),
			status: 'ready',
			rootDir: '/workspace',
			environment: 'basic',
			readFile: async () => Buffer.from(contents, 'utf-8'),
			writeFile: async () => {},
			exec: async () => ({ stdout: 'ran', stderr: '', exitCode: 0 }),
			listFiles: async () => [],
			destroy: async () => {},
		} as unknown as Sandbox
	}

	it('a client read WINS over the on-disk content for the same path', async () => {
		const wrapped = clientBackedSandbox(diskSandbox('what was saved'), {
			readTextFile: async () => 'what the user is looking at',
			writeTextFile: async () => {},
		})

		// The concrete failure: the user has unsaved changes, the agent reads
		// disk, and the model patches text that has already been replaced.
		expect((await wrapped.readFile('a.ts')).toString('utf-8')).toBe('what the user is looking at')
	})

	it('falls back to disk when the client declared no filesystem', async () => {
		const plain = clientBackedSandbox(diskSandbox('what was saved'), undefined)

		// The other direction, and the one that keeps the test above honest: a
		// decorator that always returned the buffer would pass it while
		// breaking every peer that is not an editor.
		expect((await plain.readFile('a.ts')).toString('utf-8')).toBe('what was saved')
	})

	it('leaves every other sandbox member alone', async () => {
		const wrapped = clientBackedSandbox(diskSandbox('x'), {
			readTextFile: async () => 'y',
			writeTextFile: async () => {},
		})

		// A client-backed object that implemented only the file methods would
		// take `bash` away from a session that had it.
		expect((await wrapped.exec('echo')).stdout).toBe('ran')
		expect(wrapped.rootDir).toBe('/workspace')
	})

	it('routes a write to the client rather than to disk', async () => {
		const written: { path: string; content: string }[] = []
		let disk = 0
		const wrapped = clientBackedSandbox(
			{ ...diskSandbox('x'), writeFile: async () => void disk++ } as unknown as Sandbox,
			{
				readTextFile: async () => 'y',
				writeTextFile: async (path, content) => void written.push({ path, content }),
			},
		)

		await wrapped.writeFile('a.ts', 'new text')

		// Writing to disk under an editor is how an agent clobbers an unsaved
		// buffer — the mirror of the read failure.
		expect(written).toEqual([{ path: 'a.ts', content: 'new text' }])
		expect(disk).toBe(0)
	})

	it('surfaces a client read failure as an error the caller can route around', async () => {
		const wrapped = clientBackedSandbox(diskSandbox('x'), {
			readTextFile: async () => {
				throw new Error('no such buffer')
			},
			writeTextFile: async () => {},
		})

		// It REJECTS rather than silently returning the disk copy. A fallback
		// here would answer a failed read with stale text, which is the exact
		// thing the capability exists to stop — and the tool layer turns a
		// rejection into a tool error the model can act on.
		await expect(wrapped.readFile('a.ts')).rejects.toThrow('no such buffer')
	})
})

describe('a client that errors on a request', () => {
	it('does not take the session down, and the next prompt still works', async () => {
		const wire = pair()
		const stop = autoAnswering(wire, {
			[ACP_CLIENT_REQUESTS.REQUEST_PERMISSION]: new Error('the editor window closed'),
		})

		const seen: string[] = []
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				prompt: async ({ ask, sessionId, prompt }) => {
					try {
						await ask({ sessionId, toolCalls: [] })
						seen.push(`${prompt}:asked`)
					} catch (err) {
						seen.push(`${prompt}:${err instanceof Error ? err.message : 'unknown'}`)
					}
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
			newSessionId: () => 'ses_one',
		})
		const sessionId = await open(wire, server)

		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId, prompt: 'first' },
		})
		await new Promise((resolve) => setTimeout(resolve, 40))
		wire.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId, prompt: 'second' },
		})
		await new Promise((resolve) => setTimeout(resolve, 40))
		stop()

		expect(seen[0]).toBe('first:the editor window closed')
		// The connection survived: the second prompt was served and answered.
		expect(wire.sent.find((m) => m.id === 4)?.result).toEqual({ stopReason: 'end_turn' })
	})
})

describe('session/load', () => {
	it('answers with the SAME id and hands the prior turns to the next prompt', async () => {
		const wire = pair()
		let handed: readonly unknown[] | undefined
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				load: async (id) => [{ role: 'user', content: `earlier in ${id}` }],
				prompt: async ({ history }) => {
					handed = history
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		wire.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: CAPS } })
		await settle()

		wire.deliver({
			jsonrpc: '2.0',
			id: 2,
			method: 'session/load',
			params: { sessionId: 'ses_from_yesterday' },
		})
		await settle()

		// The same id: a client that asked to resume `ses_x` and got `ses_y`
		// back has to rewrite everything it had keyed by the old one.
		expect(wire.sent.find((m) => m.id === 2)?.result).toEqual({
			sessionId: 'ses_from_yesterday',
		})

		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_from_yesterday', prompt: 'and then?' },
		})
		await settle()

		// Returning an empty history would make a resumed session a fresh one
		// wearing the old id — the model would answer with no idea what was
		// already said.
		expect(handed).toEqual([{ role: 'user', content: 'earlier in ses_from_yesterday' }])
	})

	it('refuses when the agent has no session store rather than resuming nothing', async () => {
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: { prompt: async () => ({ stopReason: 'end_turn' }) },
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		wire.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: CAPS } })
		await settle()
		wire.deliver({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'ses_x' } })
		await settle()

		// An empty history is indistinguishable from a session that really had
		// no turns, so saying "I cannot resume" is the only honest answer.
		expect(wire.sent.find((m) => m.id === 2)?.error).toBeDefined()
	})

	it('refuses a resume from a client with no permission capability', async () => {
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: { load: async () => [], prompt: async () => ({ stopReason: 'end_turn' }) },
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		wire.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: [] } })
		await settle()
		wire.deliver({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'ses_x' } })
		await settle()

		// Resuming is a way to get a session, so it carries the same condition
		// as creating one. A refusal on `session/new` that `session/load` walks
		// around is not a refusal.
		expect(wire.sent.find((m) => m.id === 2)?.error?.message).toContain(ACP_PERMISSION_CAPABILITY)
	})
})

describe('the client answering after the connection closed', () => {
	it('rejects what was still waiting instead of leaving it pending forever', async () => {
		const wire = pair()
		let failure: unknown
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				prompt: async ({ ask, sessionId }) => {
					try {
						await ask({ sessionId, toolCalls: [] })
					} catch (err) {
						failure = err
					}
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
			newSessionId: () => 'ses_one',
		})
		const sessionId = await open(wire, server)
		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId, prompt: 'go' },
		})
		await settle()

		await server.stop()
		await settle()

		// A promise nobody will ever settle keeps whatever awaited it alive —
		// here, a whole run parked on a question with no one left to answer.
		expect((failure as Error)?.message).toContain('closed before it answered')
	})
})

describe('the outcomes the wire can carry', () => {
	async function outcomeFor(answer: unknown): Promise<unknown> {
		const wire = pair()
		const stop = autoAnswering(wire, { [ACP_CLIENT_REQUESTS.REQUEST_PERMISSION]: answer })
		let seen: unknown
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				prompt: async ({ ask, sessionId }) => {
					seen = await ask({ sessionId, toolCalls: [] })
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
			newSessionId: () => 'ses_one',
		})
		const sessionId = await open(wire, server)
		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId, prompt: 'go' },
		})
		await new Promise((resolve) => setTimeout(resolve, 40))
		stop()
		return seen
	}

	it('a plain approve stays a plain approve', async () => {
		// Untested until a coverage breach pointed at the arm: the whole
		// exchange had only ever been driven with `reject` and `approve_all`,
		// so the one outcome a human picks most often was never asserted.
		expect(await outcomeFor({ outcome: 'approve' })).toEqual({ kind: 'approve' })
	})

	it('a rejection with no feedback carries none, so the mapper supplies the default', async () => {
		// `{ kind: 'reject' }` with no key, NOT `{ feedback: undefined }`: the
		// mapper distinguishes them, and an explicit undefined would defeat the
		// `||` that installs the default sentence the model reads.
		expect(await outcomeFor({ outcome: 'reject' })).toEqual({ kind: 'reject' })
	})
})

describe('frames and values at their edges', () => {
	it('serves a call that carries no params at all', async () => {
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: { prompt: async () => ({ stopReason: 'end_turn' }) },
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()

		// `initialize` with the key absent, not `params: {}`. A client is
		// allowed to omit it and a dispatcher that read `message.params.x`
		// would throw on the very first frame of every connection.
		wire.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize' })
		await settle()

		expect(wire.sent.find((m) => m.id === 1)?.result).toBeDefined()
	})

	it('writes a Buffer through the client as text', async () => {
		const written: string[] = []
		const wrapped = clientBackedSandbox(
			{
				id: fixtureId.sandbox('buf'),
				status: 'ready',
				rootDir: '/w',
				environment: 'basic',
				readFile: async () => Buffer.from('disk'),
				writeFile: async () => {},
				exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
				listFiles: async () => [],
				destroy: async () => {},
			} as unknown as Sandbox,
			{
				readTextFile: async () => 'buffer',
				writeTextFile: async (_p, content) => void written.push(content),
			},
		)

		// `Sandbox.writeFile` accepts a Buffer, and the client's method takes
		// text. Handing it `[object Object]` is the shape of that mistake.
		await wrapped.writeFile('a.bin', Buffer.from('from a buffer', 'utf-8'))
		expect(written).toEqual(['from a buffer'])
	})
})
