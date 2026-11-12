import { generateTenantId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import type { SessionSendReceipt, SessionSendStatus } from '../integrations/peers/send-person.js'
import {
	DEFAULT_SEND_WAIT_SECONDS,
	EXIT_SEND_ACCEPTED,
	type SendIO,
	exitCodeOfSend,
	parseSendArgs,
	renderSendReceipt,
	runSend,
} from './send.js'

async function* chunks(...parts: string[]): AsyncIterable<string> {
	for (const part of parts) yield part
}

function io(over: Partial<SendIO> & { sent?: Record<string, unknown>[] } = {}) {
	const out: string[] = []
	const err: string[] = []
	const { sent = [], ...rest } = over
	const surroundings: SendIO = {
		home: '/h',
		tenantId: generateTenantId(),
		cwd: '/w',
		stdin: Object.assign(chunks(), { isTTY: true }),
		stdout: (t) => void out.push(t),
		stderr: (t) => void err.push(t),
		timer: () => new Promise<void>(() => {}),
		send: async (options) => {
			sent.push(options as never)
			return { status: 'delivered', reason: 'The session took the message into its turn.' }
		},
		...rest,
	}
	return { io: surroundings, out, err, sent }
}

describe('parseSendArgs', () => {
	it('takes a session and words, flags anywhere, and ends flags at --', () => {
		expect(parseSendArgs(['abc', 'stop', 'after', 'this', '--json'])).toMatchObject({
			session: 'abc',
			words: ['stop', 'after', 'this'],
			json: true,
			waitSeconds: DEFAULT_SEND_WAIT_SECONDS,
		})
		expect(parseSendArgs(['abc', '--', '--wait', '5'])).toMatchObject({ words: ['--wait', '5'] })
		expect(parseSendArgs(['--wait=0', 'abc', 'hi'])).toMatchObject({ waitSeconds: 0 })
		expect(parseSendArgs(['abc', '--file', '-'])).toMatchObject({ file: '-', words: [] })
	})

	it('refuses what it cannot read as a command', () => {
		expect(parseSendArgs([])).toHaveProperty('error')
		expect(parseSendArgs(['abc', '--wait', 'soon'])).toHaveProperty('error')
		expect(parseSendArgs(['abc', '--wait', '99999'])).toHaveProperty('error')
		expect(parseSendArgs(['abc', '--wait'])).toHaveProperty('error')
		expect(parseSendArgs(['abc', '--mode', 'x', 'hi'])).toHaveProperty('error')
		expect(parseSendArgs(['abc', 'words', '--file', 'f'])).toHaveProperty('error')
	})
})

describe('exit status', () => {
	it('gives every answer its own', () => {
		const statuses: SessionSendStatus[] = [
			'delivered',
			'accepted',
			'refused',
			'unreachable',
			'not-found',
		]
		const codes = statuses.map(exitCodeOfSend)
		expect(codes).toEqual([0, EXIT_SEND_ACCEPTED, 1, 69, 66])
		expect(new Set(codes).size).toBe(statuses.length)
	})
})

describe('runSend', () => {
	it('sends words as the person’s message and prints the answer', async () => {
		const run = io()
		const code = await runSend(parseSendArgs(['abc', 'stop', 'after', 'this']), run.io)
		expect(code).toBe(0)
		expect(run.sent[0]).toMatchObject({ session: 'abc', message: 'stop after this' })
		expect(run.sent[0]).toHaveProperty('window')
		expect(run.out.join('')).toBe('Delivered: The session took the message into its turn.\n')
	})

	it('does not wait with --wait 0', async () => {
		const run = io()
		await runSend(parseSendArgs(['abc', 'hi', '--wait', '0']), run.io)
		expect(run.sent[0]).not.toHaveProperty('window')
	})

	it('reads piped standard input when there are no words, keeping its lines, and treats a leading slash as text', async () => {
		const run = io({ stdin: Object.assign(chunks('/stop\nsecond line\n'), { isTTY: false }) })
		expect(await runSend(parseSendArgs(['abc']), run.io)).toBe(0)
		expect(run.sent[0]).toMatchObject({ message: '/stop\nsecond line' })
	})

	it('asks for a message instead of waiting on a terminal, and refuses an empty one', async () => {
		const run = io()
		expect(await runSend(parseSendArgs(['abc']), run.io)).toBe(64)
		expect(run.sent).toHaveLength(0)
		const blank = io({ stdin: Object.assign(chunks('\n'), { isTTY: false }) })
		expect(await runSend(parseSendArgs(['abc']), blank.io)).toBe(64)
		expect(blank.sent).toHaveLength(0)
	})

	it('refuses input that is not text, and input over the limit, before sending', async () => {
		const binary = io({
			stdin: Object.assign(chunks('ok\0'), { isTTY: false }),
		})
		expect(await runSend(parseSendArgs(['abc']), binary.io)).toBe(65)
		const big = io({ stdin: Object.assign(chunks('x'.repeat(40_000)), { isTTY: false }) })
		expect(await runSend(parseSendArgs(['abc']), big.io)).toBe(1)
		expect(big.sent.length + binary.sent.length).toBe(0)
	})

	it('prints one JSON object with the exit status when asked', async () => {
		const receipt: SessionSendReceipt = {
			status: 'accepted',
			reason: 'queued',
			sessionId: 's',
			id: 'i',
		}
		const run = io({ send: async () => receipt })
		const code = await runSend(parseSendArgs(['abc', 'hi', '--json']), run.io)
		expect(code).toBe(EXIT_SEND_ACCEPTED)
		expect(JSON.parse(run.out.join(''))).toEqual({ ...receipt, exit: EXIT_SEND_ACCEPTED })
		const bad = io()
		expect(await runSend(parseSendArgs(['abc', '--json']), bad.io)).toBe(64)
		expect(JSON.parse(bad.out.join(''))).toEqual({
			error: 'send needs a message: give words, --file, or pipe text in.',
			exit: 64,
		})
	})

	it('shows the session’s words through terminal escaping', () => {
		expect(renderSendReceipt({ status: 'refused', reason: 'No.' })).toBe('Refused: No.')
	})
})
