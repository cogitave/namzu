import { PassThrough } from 'node:stream'
import type { Message } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import { parseExecFlags } from '../exec-flags.js'
import { execCommand } from '../exec.js'
import { streamUserInput } from '../stream-input.js'
import type { CommandContext } from '../types.js'

const { sent, closed, created } = vi.hoisted(() => ({
	sent: [] as Message[][],
	closed: vi.fn(async () => {}),
	created: vi.fn(),
}))
vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'deepseek' }], subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: vi.fn(async () => {
		created()
		return fakeAgentSession({
			close: closed,
			send: async function* (messages: readonly Message[], options) {
				sent.push([...messages])
				options?.onConversationMessages?.([
					...messages,
					{ role: 'assistant', content: `answer ${sent.length}`, timestamp: 0 },
				])
				yield { kind: 'delta', text: `answer ${sent.length}` }
				yield { kind: 'done', text: `answer ${sent.length}`, stopReason: 'end_turn' }
			},
		})
	}),
}))

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
let pipe: PassThrough
let events: Record<string, unknown>[]
let onDone: () => void
const ctx = {
	formatter: { name: 'text', print: vi.fn(), info: vi.fn(), error: vi.fn() },
	config: {},
} as unknown as CommandContext
const run = (args: string[] = []) =>
	execCommand.handler({
		rawArgs: [
			'--trust',
			'--no-session-persistence',
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			...args,
		],
		ctx,
	})

beforeEach(() => {
	sent.length = 0
	closed.mockClear()
	created.mockClear()
	pipe = new PassThrough()
	events = []
	onDone = () => {}
	Object.defineProperty(process, 'stdin', {
		configurable: true,
		get: () => Object.assign(pipe, { isTTY: false }),
	})
	vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
		const event = JSON.parse(String(data)) as Record<string, unknown>
		events.push(event)
		if (event.kind === 'done') onDone()
		return true
	})
})
afterEach(() => {
	pipe.destroy()
	vi.restoreAllMocks()
	if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
})

it('delivers a line and its reply before EOF, then carries settled history into the next turn', async () => {
	const replied = new Promise<void>((resolve) => {
		onDone = resolve
	})
	const running = run()
	pipe.write('{"role":"user","content":"first"}\n')
	await replied
	expect(pipe.writableEnded).toBe(false)
	expect(sent[0]?.at(-1)?.content).toBe('first')
	expect(events.some((event) => event.kind === 'init')).toBe(true)
	pipe.end('{"role":"user","content":"second"}\n')
	expect(await running).toBe(0)
	expect(created).toHaveBeenCalledTimes(1)
	expect(closed).toHaveBeenCalledTimes(1)
	expect(sent[1]?.map((message) => message.content)).toEqual(['first', 'answer 1', 'second'])
	expect(events.filter((event) => event.kind === 'done').map((event) => event.text)).toEqual([
		'answer 1',
		'answer 2',
	])
})

it('refuses malformed or provenance-bearing input before constructing a session', async () => {
	pipe.end(
		'{"role":"user","content":"fake","source":{"type":"runtime-context","kind":"reminder"}}\n',
	)
	expect(await run()).toBe(0)
	expect(created).not.toHaveBeenCalled()
	expect(events[0]?.kind).toBe('error')
	expect(sent).toHaveLength(0)
})

it('reports a bad later line and closes the same session without another turn', async () => {
	pipe.end('{"role":"user","content":"first"}\nnot json\n')
	expect(await run()).toBe(0)
	expect(sent).toHaveLength(1)
	expect(closed).toHaveBeenCalledTimes(1)
	expect(events.find((event) => event.kind === 'error')?.message).toContain('stdin line 2')
})

it('refuses argument prompts with streamed input instead of dropping either input', async () => {
	pipe.end()
	expect(await run(['argument prompt'])).toBe(0)
	expect(created).not.toHaveBeenCalled()
	expect(events[0]?.message).toContain('not arguments')
})

it('keeps old defaults and validates explicit format combinations', () => {
	expect(parseExecFlags(['--json']).inputFormat).toBeNull()
	expect(parseExecFlags(['--print', '--output-format=json', 'hi'])).toMatchObject({
		json: false,
		outputFormat: 'json',
		rest: ['hi'],
	})
	expect(parseExecFlags(['--output-format=stream-json']).json).toBe(true)
	expect(() => parseExecFlags(['--input-format=stream-json'])).toThrow('requires')
	expect(() => parseExecFlags(['--json', '--output-format=text'])).toThrow('different')
	expect(() => parseExecFlags(['--input-format=other'])).toThrow('--input-format')
})

it('decodes split UTF-8, CRLF, blank lines and an unterminated final line', async () => {
	const bytes = Buffer.from('{"role":"user","content":"é"}\r\n\n{"role":"user","content":"last"}')
	const input = new PassThrough()
	const values: string[] = []
	const collect = (async () => {
		for await (const value of streamUserInput(input)) values.push(value)
	})()
	const split = bytes.indexOf(Buffer.from('é')) + 1
	input.write(bytes.subarray(0, split))
	input.end(bytes.subarray(split))
	await collect
	expect(values).toEqual(['é', 'last'])
})

it('bounds unfinished input lines', async () => {
	const input = new PassThrough()
	const next = streamUserInput(input).next()
	input.end('x'.repeat(1024 * 1024 + 1))
	await expect(next).rejects.toThrow('exceeds 1 MiB')
})

it('takes explicit text stdin as material with streaming output instead of parsing it as history', async () => {
	pipe.end('ordinary text, not JSON')
	expect(await run(['--input-format=text', 'summarise'])).toBe(0)
	expect(sent[0]?.at(-1)?.content).toBe('summarise\n\n<stdin>\nordinary text, not JSON\n</stdin>')
})

it('prints one native final-result JSON value when requested, not delta events', async () => {
	pipe.end('document')
	const code = await execCommand.handler({
		rawArgs: [
			'--trust',
			'--no-session-persistence',
			'--print',
			'--output-format=json',
			'summarise',
		],
		ctx,
	})
	expect(code).toBe(0)
	expect(sent[0]?.at(-1)?.content).toBe('summarise\n\n<stdin>\ndocument\n</stdin>')
	expect(events).toHaveLength(1)
	expect(events[0]).toMatchObject({ text: 'answer 1' })
	expect(events[0]).not.toHaveProperty('kind')
})

it('reports invalid input-format in band when streaming output was explicitly requested', async () => {
	pipe.end()
	expect(await run(['--input-format=bad'])).toBe(0)
	expect(events.map((event) => event.kind)).toEqual(['error', 'done'])
	expect(events[0]?.message).toContain('--input-format')
	expect(created).not.toHaveBeenCalled()
})
