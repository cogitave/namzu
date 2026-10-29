import { spawn } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { EXIT_USAGE } from '../../exit-codes.js'

/**
 * `exec --no-session-persistence` keeps no record, and `--fork-session`
 * carries on in a copy. The real binary against a local endpoint that answers
 * every completion at once.
 */

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'bin.js')

const roots: string[] = []
const servers: Server[] = []
afterEach(() => {
	for (const server of servers.splice(0)) server.close()
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function answeringProvider(onCompletion?: () => boolean): Promise<string> {
	const server = createServer((req, res) => {
		req.resume()
		req.on('end', () => {
			if (req.method === 'GET') {
				res.setHeader('content-type', 'application/json')
				res.end(
					JSON.stringify({
						object: 'list',
						data: [{ id: 'gpt-4o', object: 'model', created: 0, owned_by: 'test' }],
					}),
				)
				return
			}
			// The request is a deterministic barrier: the turn is running, but
			// the provider has not answered. No timing poll can miss the write.
			if (onCompletion && !onCompletion()) return
			const chunk = {
				id: 'c1',
				object: 'chat.completion.chunk',
				created: 1,
				model: 'gpt-4o',
				choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
			}
			res.setHeader('content-type', 'text/event-stream')
			res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
		})
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('no port')
	return `http://127.0.0.1:${address.port}/v1`
}

interface Workspace {
	readonly home: string
	readonly work: string
	readonly url: string
}

async function workspace(onCompletion?: () => boolean): Promise<Workspace> {
	const root = mkdtempSync(join(realpathSync(tmpdir()), 'namzu-exec-persistence-'))
	roots.push(root)
	const home = join(root, 'home')
	const work = join(root, 'work')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(work)
	return { home, work, url: await answeringProvider(onCompletion) }
}

function run(
	w: Workspace,
	args: readonly string[],
	onSpawn?: (child: ReturnType<typeof spawn>) => void,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				CLI_BIN,
				'exec',
				'--trust',
				'--provider',
				'openai',
				'--model',
				'gpt-4o',
				'--cwd',
				w.work,
				...args,
			],
			{
				env: {
					PATH: process.env.PATH ?? '',
					HOME: w.home,
					NAMZU_HOME: join(w.home, '.namzu'),
					NAMZU_LOG_LEVEL: 'silent',
					OPENAI_API_KEY: 'sk-test',
					OPENAI_BASE_URL: w.url,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		let stdout = ''
		let stderr = ''
		child.stdout?.on('data', (chunk) => {
			stdout += chunk
		})
		child.stderr?.on('data', (chunk) => {
			stderr += chunk
		})
		child.on('close', (code) => resolve({ code, stdout, stderr }))
		onSpawn?.(child)
	})
}

/** Every conversation log the workspace holds, by file name. */
function logs(w: Workspace): string[] {
	const projects = join(w.home, '.namzu', 'projects')
	if (!existsSync(projects)) return []
	return readdirSync(projects)
		.flatMap((slug) => readdirSync(join(projects, slug)).map((name) => join(projects, slug, name)))
		.filter((file) => file.endsWith('.jsonl'))
		.sort()
}

describe('namzu exec --no-session-persistence', () => {
	it.each([{ mode: [] }, { mode: ['--json'] }])(
		'has no journal while the provider is running, even after SIGKILL ($mode)',
		async ({ mode }) => {
			let child: ReturnType<typeof spawn> | undefined
			let inFlight: string[] | undefined
			const w = await workspace(() => {
				inFlight = logs(w)
				child?.kill('SIGKILL')
				return false
			})
			const result = await run(w, [...mode, '--no-session-persistence', 'hi'], (process) => {
				child = process
			})
			expect(result.code).toBeNull()
			expect(inFlight).toEqual([])
			expect(logs(w)).toEqual([])
		},
		60_000,
	) // Real CLI subprocess and local HTTP I/O, not a timeout race.

	it('answers and leaves no conversation behind', async () => {
		const w = await workspace()
		const result = await run(w, ['--no-session-persistence', 'hi'])
		expect(result.code).toBe(0)
		expect(result.stdout).toContain('Done.')
		expect(logs(w)).toEqual([])
	}, 60_000)

	it('works on a copy of a resumed conversation and never writes to the original', async () => {
		const w = await workspace()
		expect((await run(w, ['hi'])).code).toBe(0)
		const [original] = logs(w)
		expect(original).toBeDefined()
		const before = readFileSync(original as string, 'utf8')

		const result = await run(w, ['--no-session-persistence', '--continue', 'and again'])
		expect(result.code).toBe(0)
		expect(result.stdout).toContain('Done.')
		expect(logs(w)).toEqual([original])
		expect(readFileSync(original as string, 'utf8')).toBe(before)
	}, 120_000)
})

describe('namzu exec --fork-session', () => {
	it('carries on in a copy and leaves the original as it was', async () => {
		const w = await workspace()
		expect((await run(w, ['hi'])).code).toBe(0)
		const [original] = logs(w)
		const before = readFileSync(original as string, 'utf8')

		const result = await run(w, ['--fork-session', '--continue', 'and again'])
		expect(result.code).toBe(0)
		expect(result.stderr).toContain('carrying on in a copy')
		expect(logs(w)).toHaveLength(2)
		expect(readFileSync(original as string, 'utf8')).toBe(before)
	}, 120_000)

	it('is refused without a conversation to copy', async () => {
		const w = await workspace()
		const result = await run(w, ['--fork-session', 'hi'])
		expect(result.code).toBe(EXIT_USAGE)
		expect(result.stderr).toContain('--continue or --resume')
		expect(logs(w)).toEqual([])
	}, 60_000)
})
