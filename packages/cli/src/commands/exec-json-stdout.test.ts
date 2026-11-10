import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))

/**
 * The `exec --json` contract (docs/cli/exec-json.md): every stdout line is one
 * JSON event with a `kind`; logs, including the `--debug` trace and the
 * NDJSON log records, go to stderr. Run against the built binary because the
 * stream is what a machine reader sees, whatever wrote it.
 */
it('writes only events on stdout and the logs on stderr, with --debug and --verbose on', async () => {
	expect(existsSync(BIN), `${BIN} is missing: run \`pnpm --filter @namzu/cli build\` first`).toBe(
		true,
	)
	const home = mkdtempSync(join(tmpdir(), 'namzu-exec-json-stdout-'))
	try {
		const { stdout, stderr, code } = await new Promise<{
			stdout: string
			stderr: string
			code: number | null
		}>((resolve, reject) => {
			// An unknown provider fails before any network call, after the logging
			// sink is installed, so stderr carries records and stdout the error.
			const child = spawn(
				process.execPath,
				[
					BIN,
					'--debug',
					'--verbose',
					'exec',
					'--trust',
					'--json',
					'--provider',
					'nope',
					'--',
					'hi',
				],
				{
					cwd: home,
					env: { PATH: process.env.PATH ?? '', HOME: home, CI: '1', LANG: 'C.UTF-8' },
				},
			)
			let out = ''
			let err = ''
			child.stdout.on('data', (chunk) => {
				out += chunk
			})
			child.stderr.on('data', (chunk) => {
				err += chunk
			})
			child.on('error', reject)
			child.on('close', (exit) => resolve({ stdout: out, stderr: err, code: exit }))
		})
		expect(code).toBe(0)
		const lines = stdout.split('\n').filter((line) => line.length > 0)
		expect(lines.length).toBeGreaterThan(0)
		for (const line of lines) {
			const event = JSON.parse(line) as Record<string, unknown>
			expect(typeof event.kind, line).toBe('string')
		}
		expect(JSON.parse(lines.at(-1) as string)).toMatchObject({ kind: 'done' })
		// The logs exist, and they are on the other stream.
		expect(stderr.length).toBeGreaterThan(0)
	} finally {
		removeTempDir(home)
	}
	// A real subprocess: Vitest's per-test timeout is the hang guard, raised for process start-up.
}, 60_000)

/**
 * The same contract through a whole model turn. The provider is a local server
 * speaking the Anthropic wire, so the provider driver, the turn loop and the
 * debug and verbose logging all run mid-turn, and nothing of theirs may reach
 * stdout. The usage frame carries the cache split a warm call really has: 4
 * uncached input tokens beside 26 378 written to the cache.
 */
it('keeps stdout to events through a model turn, and reports the whole prompt', async () => {
	expect(existsSync(BIN), `${BIN} is missing: run \`pnpm --filter @namzu/cli build\` first`).toBe(
		true,
	)
	const frame = (type: string, body: Record<string, unknown>): string =>
		`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`
	const server: Server = createServer((req, res) => {
		req.resume()
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'text/event-stream' })
			res.write(
				frame('message_start', {
					message: {
						id: 'msg_1',
						type: 'message',
						role: 'assistant',
						model: 'claude-haiku-5-5',
						content: [],
						usage: {
							input_tokens: 4,
							cache_creation_input_tokens: 26378,
							cache_read_input_tokens: 0,
							output_tokens: 1,
						},
					},
				}),
			)
			res.write(
				frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
			)
			res.write(
				frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } }),
			)
			res.write(frame('content_block_stop', { index: 0 }))
			res.write(
				frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
			)
			res.write(frame('message_stop', {}))
			res.end()
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	const port = typeof address === 'object' && address ? address.port : 0
	const home = mkdtempSync(join(tmpdir(), 'namzu-exec-json-turn-'))
	try {
		const { stdout, stderr, code } = await new Promise<{
			stdout: string
			stderr: string
			code: number | null
		}>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					BIN,
					'--debug',
					'--verbose',
					'exec',
					'--trust',
					'--json',
					'--provider',
					'anthropic',
					'--model',
					'claude-haiku-5-5',
					'--',
					'hi',
				],
				{
					cwd: home,
					env: {
						PATH: process.env.PATH ?? '',
						HOME: home,
						CI: '1',
						LANG: 'C.UTF-8',
						ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
						ANTHROPIC_AUTH_TOKEN: 'fixture',
						ANTHROPIC_API_KEY: 'fixture',
					},
				},
			)
			let out = ''
			let err = ''
			child.stdout.on('data', (chunk) => {
				out += chunk
			})
			child.stderr.on('data', (chunk) => {
				err += chunk
			})
			child.on('error', reject)
			child.on('close', (exit) => resolve({ stdout: out, stderr: err, code: exit }))
		})
		expect(code, stderr.slice(-800)).toBe(0)
		const events = stdout
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => {
				const event = JSON.parse(line) as Record<string, unknown>
				expect(typeof event.kind, line).toBe('string')
				return event
			})
		expect(events.at(-1)).toMatchObject({ kind: 'done', text: 'hello' })
		expect(events.find((event) => event.kind === 'usage')).toMatchObject({
			inputTokens: 4,
			cacheWriteTokens: 26378,
			contextTokens: 26382,
			contextMeasuredBy: 'provider',
		})
		expect(stderr.length).toBeGreaterThan(0)
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()))
		removeTempDir(home)
	}
	// A real subprocess and socket: Vitest's per-test timeout is the hang guard, raised for process start-up.
}, 60_000)
