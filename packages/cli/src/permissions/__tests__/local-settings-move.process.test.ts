import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'

/**
 * The move as a person meets it: a project that only has the earlier
 * `namzu.config.local.json`, with an answer saved in it, and the built `namzu`
 * run there twice. The first run moves the file into `.namzu/settings.local.json`;
 * both runs let the saved answer decide a call, so the answer survived the move.
 *
 * The runs are headless (`namzu exec`) in the mode that allows only what a rule
 * allows, so the saved answer is the one thing that lets `touch` run, and a
 * command no rule names is refused. The model is a local server speaking the
 * vendor's wire format; its commands are scripted. Nothing waits on a clock:
 * each run ends when its process ends.
 */

const BIN = fileURLToPath(new URL('../../../dist/bin.js', import.meta.url))
const SAVED = `{\n\t"permissions": {\n\t\t"bash": {\n\t\t\t"touch *": "allow"\n\t\t}\n\t}\n}\n`

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
	for (const root of roots.splice(0)) removeTempDir(root)
})

const frame = (type: string, body: Record<string, unknown>): string =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`

/** A model that runs `commands` one tool call at a time, then says it is done. */
async function model(commands: readonly string[]): Promise<number> {
	const server = createServer((req, res) => {
		let raw = ''
		req.on('data', (chunk) => {
			raw += chunk
		})
		req.on('end', () => {
			const body = JSON.parse(raw) as {
				tools?: unknown[]
				messages: Array<{ role: string; content: unknown }>
			}
			const results = body.messages.flatMap((message) =>
				Array.isArray(message.content)
					? (message.content as Record<string, unknown>[]).filter(
							(block) => block.type === 'tool_result',
						)
					: [],
			)
			res.writeHead(200, { 'content-type': 'text/event-stream' })
			res.write(
				frame('message_start', {
					message: {
						id: 'm',
						type: 'message',
						role: 'assistant',
						model: 'claude-haiku-5-5',
						content: [],
						usage: { input_tokens: 5, output_tokens: 1 },
					},
				}),
			)
			// A request with no tools is the kernel's own small request: an answer of its own.
			const next = body.tools ? commands[results.length] : undefined
			if (next !== undefined) {
				res.write(
					frame('content_block_start', {
						index: 0,
						content_block: { type: 'tool_use', id: `tu${results.length}`, name: 'bash', input: {} },
					}),
				)
				res.write(
					frame('content_block_delta', {
						index: 0,
						delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: next }) },
					}),
				)
				res.write(frame('content_block_stop', { index: 0 }))
				res.write(
					frame('message_delta', {
						delta: { stop_reason: 'tool_use' },
						usage: { output_tokens: 3 },
					}),
				)
			} else {
				const answer = body.tools ? 'MODEL-DONE' : 'KERNEL-SMALL-REQUEST-ANSWER'
				res.write(
					frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
				)
				res.write(
					frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } }),
				)
				res.write(frame('content_block_stop', { index: 0 }))
				res.write(
					frame('message_delta', {
						delta: { stop_reason: 'end_turn' },
						usage: { output_tokens: 3 },
					}),
				)
			}
			res.write(frame('message_stop', {}))
			res.end()
		})
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	return typeof address === 'object' && address ? address.port : 0
}

function world() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-local-move-e2e-'))
	roots.push(root)
	const home = join(root, 'home')
	const namzuHome = join(home, '.namzu')
	const work = join(root, 'work')
	const runtime = join(root, 'xdg')
	mkdirSync(namzuHome, { recursive: true })
	mkdirSync(work)
	mkdirSync(runtime, { mode: 0o700 })
	// The sandbox off in the person's own file, so the rule alone decides whether a command runs.
	writeFileSync(join(namzuHome, 'config.yaml'), 'sandbox:\n  enabled: false\n')
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		NAMZU_HOME: namzuHome,
		XDG_RUNTIME_DIR: runtime,
		GIT_CONFIG_NOSYSTEM: '1',
		NO_COLOR: '1',
		CI: '1',
		LANG: 'C.UTF-8',
	}
	return { work, env }
}

/** One headless run whose model runs `commands`. Resolves when the process ends. */
async function run(w: ReturnType<typeof world>, commands: readonly string[]): Promise<void> {
	const port = await model(commands)
	const child = spawn(
		process.execPath,
		[
			BIN,
			'exec',
			'--trust',
			'--permission-mode',
			'strict',
			'--provider',
			'anthropic',
			'--model',
			'claude-haiku-5-5',
			'--',
			'go',
		],
		{
			cwd: w.work,
			env: {
				...w.env,
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
				ANTHROPIC_AUTH_TOKEN: 'fixture',
				ANTHROPIC_API_KEY: 'fixture',
			},
			stdio: ['ignore', 'ignore', 'ignore'],
		},
	)
	await new Promise<void>((resolve, reject) => {
		child.on('error', reject)
		child.on('close', () => resolve())
	})
}

describe.runIf(process.platform !== 'win32')(
	'a project that has only the earlier local file, run with the built namzu',
	() => {
		// Two real CLI processes, each booting the whole graph: slow on a busy runner, never a race.
		it(
			'moves the file into .namzu/settings.local.json and keeps the saved answer deciding',
			{ timeout: 180_000 },
			async () => {
				expect(
					existsSync(BIN),
					`${BIN} is missing: run \`pnpm --filter @namzu/cli build\` first`,
				).toBe(true)
				const w = world()
				writeFileSync(join(w.work, 'namzu.config.local.json'), SAVED)

				await run(w, ['touch ALLOWED-BEFORE', 'mkdir REFUSED-BEFORE'])

				expect(existsSync(join(w.work, 'ALLOWED-BEFORE'))).toBe(true)
				expect(existsSync(join(w.work, 'REFUSED-BEFORE'))).toBe(false)
				expect(existsSync(join(w.work, 'namzu.config.local.json'))).toBe(false)
				expect(readFileSync(join(w.work, '.namzu', 'settings.local.json'), 'utf8')).toBe(SAVED)

				await run(w, ['touch ALLOWED-AFTER', 'mkdir REFUSED-AFTER'])

				expect(existsSync(join(w.work, 'ALLOWED-AFTER'))).toBe(true)
				expect(existsSync(join(w.work, 'REFUSED-AFTER'))).toBe(false)
				expect(readFileSync(join(w.work, '.namzu', 'settings.local.json'), 'utf8')).toBe(SAVED)

				// The control: with no saved answer, the same command is refused.
				const bare = world()
				await run(bare, ['touch ALLOWED-NONE'])
				expect(existsSync(join(bare.work, 'ALLOWED-NONE'))).toBe(false)
			},
		)
	},
)
