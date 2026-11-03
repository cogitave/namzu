import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'

/**
 * A model that declines to answer ends a headless run with exit code 1 and one
 * plain line on stderr, never a normal finish. The real binary against a local
 * endpoint whose every completion finishes as a content-filter refusal.
 */

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'bin.js')

const roots: string[] = []
const servers: Server[] = []
afterEach(() => {
	for (const server of servers.splice(0)) server.close()
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function decliningProvider(): Promise<string> {
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
			const chunk = {
				id: 'c1',
				object: 'chat.completion.chunk',
				created: 1,
				model: 'gpt-4o',
				choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
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

async function workspace(): Promise<Workspace> {
	const root = mkdtempSync(join(realpathSync(tmpdir()), 'namzu-exec-persistence-'))
	roots.push(root)
	const home = join(root, 'home')
	const work = join(root, 'work')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(work)
	return { home, work, url: await decliningProvider() }
}

function run(
	w: Workspace,
	args: readonly string[],
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
	})
}

describe('namzu exec when the model declines to answer', () => {
	it('exits 1 and says so plainly on stderr', async () => {
		const w = await workspace()
		const result = await run(w, ['hi'])
		expect(result.code).toBe(1)
		expect(result.stdout.trim()).toBe('')
		expect(result.stderr).toContain(
			'declined to answer this message. This sometimes happens with safe, normal requests. Rephrase the request, or run it on another model.',
		)
		expect(result.stderr).not.toMatch(/did not finish normally|new session/i)
	}, 60_000) // Real CLI subprocess and local HTTP I/O, not a timeout race.
})
