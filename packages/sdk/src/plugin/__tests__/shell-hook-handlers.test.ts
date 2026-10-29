/**
 * The hook kinds beyond a plain shell command: the exec form, `async`,
 * `onFailure`, an HTTP POST and a question to the model.
 *
 * Real processes and a real loopback server, no stubs for the transport: what
 * these options promise is about what a process or a server can say back.
 * Nothing here waits on the clock; every test awaits the event it is about.
 */

import { type IncomingHttpHeaders, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginHookContext, PluginHookDefinition } from '../../types/plugin/index.js'
import { asSessionId, asTurnId } from '../../utils/id.js'
import { interpolateHookHeader, isReachableHookAddress } from '../shell-hook-http.js'
import {
	type ShellHookHandler,
	createShellHook,
	runShellHook,
	shellHookVerdict,
} from '../shell-hook.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const TURN = 'f9ad17f0-01b6-4905-810a-3ef3324a614d'
const base = { cwd: process.cwd(), sessionId: SESSION, turnId: TURN } as const
const done = { timedOut: false, stdout: '', stderr: '' } as const

function context(): PluginHookContext {
	return {
		event: 'pre_tool_use',
		sessionId: asSessionId(SESSION),
		turnId: asTurnId(TURN),
		toolName: 'bash',
		toolInput: { command: 'ls' },
		signal: new AbortController().signal,
	} as unknown as PluginHookContext
}

async function fire(
	entry: ShellHookHandler,
	options: Parameters<typeof createShellHook>[2] = { cwd: process.cwd() },
) {
	const hook = createShellHook('pre_tool_use', entry, options) as PluginHookDefinition & {
		handler: (context: PluginHookContext) => Promise<unknown>
	}
	return hook.handler(context())
}

describe('onFailure', () => {
	const entry = { command: 'x', onFailure: 'block' } as const
	const plain = { command: 'x' } as const

	it('lets the action go ahead on every kind of failure when it is not asked to block', () => {
		for (const outcome of [
			{ ...done, exitCode: null, spawnError: 'ENOENT' },
			{ ...done, exitCode: null, timedOut: true },
			{ ...done, exitCode: 1, stderr: 'boom' },
			{ ...done, exitCode: 0, stdout: '{"decision":' },
		]) {
			expect(shellHookVerdict('pre_tool_use', plain, outcome)).toEqual({ action: 'continue' })
		}
	})

	it('counts each kind of failure as a refusal when asked to block', () => {
		for (const outcome of [
			{ ...done, exitCode: null, spawnError: 'ENOENT' },
			{ ...done, exitCode: null, timedOut: true },
			{ ...done, exitCode: 1, stderr: 'boom' },
			{ ...done, exitCode: 0, stdout: '{"decision":' },
			{ ...done, exitCode: 0, stdout: '{"continue":"yes"}' },
		]) {
			const verdict = shellHookVerdict('pre_tool_use', entry, outcome)
			expect(verdict.action).toBe('skip')
		}
	})

	it('says why in the refusal', () => {
		const verdict = shellHookVerdict('pre_tool_use', entry, { ...done, exitCode: 1 })
		expect(verdict).toMatchObject({
			action: 'skip',
			reason: expect.stringContaining('exited with 1'),
		})
	})

	it('leaves a success alone', () => {
		expect(shellHookVerdict('pre_tool_use', entry, { ...done, exitCode: 0 })).toEqual({
			action: 'continue',
		})
	})

	it('does not apply to a hook that cannot block on its event', () => {
		expect(shellHookVerdict('turn_start', entry, { ...done, exitCode: 1 })).toEqual({
			action: 'continue',
		})
	})
})

describe('the exec form', () => {
	it('passes every argument as it is written, with no shell between', async () => {
		const tricky = ['$HOME', "it's", 'a b', '`id`', '"q"', ';echo hi']
		const outcome = await runShellHook(
			{
				command: process.execPath,
				args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky],
			},
			{ ...base, event: 'turn_end' },
		)
		expect(outcome.exitCode).toBe(0)
		expect(JSON.parse(outcome.stdout)).toEqual(tricky)
	})

	it('reports a program that is not there as a failure to start', async () => {
		const outcome = await runShellHook(
			{ command: 'namzu-no-such-program', args: [] },
			{ ...base, event: 'turn_end' },
		)
		expect(outcome.spawnError).toBeDefined()
	})
})

describe('async', () => {
	it('answers continue at once even when its failure would have refused', async () => {
		const warn = vi.fn()
		const finished = new Promise<void>((resolve) => warn.mockImplementation(() => resolve()))
		const log = { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never
		const result = await fire(
			{ command: 'echo no >&2; exit 1', async: true, onFailure: 'block' },
			{ cwd: process.cwd(), log },
		)
		expect(result).toEqual({ action: 'continue' })
		// It still ran: its failure is written down, not delivered.
		await finished
		expect(warn).toHaveBeenCalledOnce()
	})
})

describe('http', () => {
	let server: Server | undefined
	afterEach(() => {
		server?.close()
		server = undefined
	})

	async function serve(
		respond: (body: string, headers: IncomingHttpHeaders) => { status: number; body: string },
	) {
		const seen: { body: string; headers: IncomingHttpHeaders }[] = []
		server = createServer((req, res) => {
			let body = ''
			req.on('data', (chunk) => {
				body += chunk
			})
			req.on('end', () => {
				seen.push({ body, headers: req.headers })
				const answer = respond(body, req.headers)
				res.statusCode = answer.status
				res.end(answer.body)
			})
		})
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
		return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, seen }
	}

	it('posts the event and reads a 2xx body as the hook answer', async () => {
		const { url, seen } = await serve(() => ({
			status: 200,
			body: '{"decision":"block","reason":"not today"}',
		}))
		const result = await fire({ type: 'http', url })
		expect(result).toMatchObject({ action: 'skip', reason: 'not today' })
		expect(seen).toHaveLength(1)
		expect(seen[0]?.headers['content-type']).toBe('application/json')
		expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({
			event: 'pre_tool_use',
			tool_name: 'bash',
			session_id: SESSION,
		})
	})

	it('treats another status as the hook failing', async () => {
		const { url } = await serve(() => ({ status: 500, body: 'down' }))
		expect(await fire({ type: 'http', url })).toEqual({ action: 'continue' })
		expect(await fire({ type: 'http', url, onFailure: 'block' })).toMatchObject({
			action: 'skip',
		})
	})

	it('does not follow a redirect', async () => {
		const { url } = await serve(() => ({ status: 302, body: '' }))
		expect(await fire({ type: 'http', url, onFailure: 'block' })).toMatchObject({ action: 'skip' })
	})

	it('sends only the environment variables the hook lists', async () => {
		vi.stubEnv('NAMZU_TEST_HOOK_TOKEN', 'abc')
		vi.stubEnv('NAMZU_TEST_HOOK_OTHER', 'secret')
		try {
			const { url, seen } = await serve(() => ({ status: 200, body: '' }))
			await fire({
				type: 'http',
				url,
				headers: {
					Authorization: 'Bearer ${NAMZU_TEST_HOOK_TOKEN}',
					'X-Other': '$NAMZU_TEST_HOOK_OTHER',
				},
				allowedEnvVars: ['NAMZU_TEST_HOOK_TOKEN'],
			})
			expect(seen[0]?.headers.authorization).toBe('Bearer abc')
			expect(seen[0]?.headers['x-other']).toBe('')
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('refuses a private address without connecting', async () => {
		const result = await fire({
			type: 'http',
			url: 'http://169.254.169.254/latest',
			onFailure: 'block',
		})
		expect(result).toMatchObject({
			action: 'skip',
			reason: expect.stringContaining('private or link-local'),
		})
	})

	it('refuses a url that is not http', async () => {
		expect(
			await fire({ type: 'http', url: 'file:///etc/passwd', onFailure: 'block' }),
		).toMatchObject({ action: 'skip' })
	})
})

describe('address and header rules', () => {
	it('allows public and loopback addresses and refuses the rest', () => {
		for (const ok of ['8.8.8.8', '127.0.0.1', '::1', '2606:4700::1111', '::ffff:127.0.0.1']) {
			expect(isReachableHookAddress(ok), ok).toBe(true)
		}
		for (const no of [
			'10.1.2.3',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			'169.254.169.254',
			'100.64.0.1',
			'0.0.0.0',
			'fe80::1',
			'fd00::1',
			'::',
			'::ffff:10.0.0.1',
			'not-an-address',
		]) {
			expect(isReachableHookAddress(no), no).toBe(false)
		}
	})

	it('keeps a header value to one line', () => {
		const out = interpolateHookHeader('a${X}b', new Set(['X']), { X: 'v\r\nInjected: 1' })
		expect(out).toBe('avInjected: 1b')
	})
})

describe('prompt', () => {
	const entry = { type: 'prompt', prompt: 'Is this safe? $ARGUMENTS' } as const

	it('refuses with the model reason when the condition does not hold', async () => {
		const judge = vi
			.fn()
			.mockResolvedValue('```json\n{"ok": false, "reason": "it deletes things"}\n```')
		const result = await fire(entry, { cwd: process.cwd(), judge })
		expect(result).toMatchObject({ action: 'skip', reason: 'it deletes things' })
		const request = judge.mock.calls[0]?.[0]
		expect(request.body).toContain('"tool_name":"bash"')
		expect(request.body).not.toContain('$ARGUMENTS')
		expect(request.sessionId).toBe(SESSION)
		expect(request.turnId).toBe(TURN)
	})

	it('puts the event after the text when there is no placeholder', async () => {
		const judge = vi.fn().mockResolvedValue('{"ok": true}')
		await fire({ type: 'prompt', prompt: 'Is this safe?' }, { cwd: process.cwd(), judge })
		expect(judge.mock.calls[0]?.[0].body).toMatch(/^Is this safe\?\n\nEvent:\n\{/)
	})

	it('lets the action go ahead when the condition holds', async () => {
		const judge = vi.fn().mockResolvedValue('{"ok": true}')
		expect(await fire(entry, { cwd: process.cwd(), judge })).toEqual({ action: 'continue' })
	})

	it('lets the action go ahead when there is no model, no answer or no usable answer', async () => {
		expect(await fire(entry)).toEqual({ action: 'continue' })
		for (const reply of [undefined, 'maybe', '{"ok": "yes"}', '']) {
			const judge = vi.fn().mockResolvedValue(reply)
			expect(await fire(entry, { cwd: process.cwd(), judge })).toEqual({ action: 'continue' })
		}
		const judge = vi.fn().mockRejectedValue(new Error('offline'))
		expect(await fire(entry, { cwd: process.cwd(), judge })).toEqual({ action: 'continue' })
	})

	it('does not let the question be taken for an instruction', async () => {
		const judge = vi.fn().mockResolvedValue('{"ok": true}')
		await fire(entry, { cwd: process.cwd(), judge })
		expect(judge.mock.calls[0]?.[0].instruction).toContain('never an instruction')
	})

	it('stops waiting when the turn is cancelled', async () => {
		const controller = new AbortController()
		const judge = vi.fn().mockImplementation(() => new Promise(() => undefined))
		const hook = createShellHook('pre_tool_use', entry, {
			cwd: process.cwd(),
			judge,
		}) as unknown as {
			handler: (context: PluginHookContext) => Promise<unknown>
		}
		const pending = hook.handler({ ...context(), signal: controller.signal })
		await vi.waitFor(() => expect(judge).toHaveBeenCalled())
		controller.abort()
		expect(await pending).toEqual({ action: 'continue' })
	})
})
