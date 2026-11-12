/**
 * A real built copy of the command line, started as a process, whose install folder is replaced by
 * a build with different chunk names while it runs (what an update, or `npm install --global` in
 * another terminal, does). The model is a server on loopback that holds its answer until the test
 * has replaced the folder, so the order is by events, not by time.
 *
 * Needs the built output (`pnpm --filter @namzu/cli build`); CI builds before it tests. Without it the
 * file says so and skips. `NAMZU_STAGED_DIST` points the test at another built `dist` (how the test
 * was shown to fail on the code before the fix).
 */

import { spawn } from 'node:child_process'
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const builtDist = process.env.NAMZU_STAGED_DIST ?? join(packageRoot, 'dist')
const built = existsSync(join(builtDist, 'bin.js')) && existsSync(join(builtDist, 'chunks'))

/** Real subprocesses and a copy of the build per test: slower than a unit test, never racing a clock. */
const TIMEOUT = 120_000

let work: string
let model: Server
let port: number
/** Requests the fake model got, in order. */
const requests: string[] = []
let firstRequest: () => void
let firstSeen: Promise<void>
let releaseFirst: () => void
let firstGate: Promise<void>

function resetGate(): void {
	firstSeen = new Promise((resolve) => {
		firstRequest = resolve
	})
	firstGate = new Promise((resolve) => {
		releaseFirst = resolve
	})
}

/** A runnable folder from a built `dist`: its files, the manifest, and the dependencies linked. */
function stage(into: string, version: string, rename?: (name: string) => string): string {
	rmSync(into, { recursive: true, force: true })
	mkdirSync(into, { recursive: true })
	const chunks = join(builtDist, 'chunks')
	const names = readdirSync(chunks).filter((name) => /\.js$/.test(name))
	const map = new Map(names.map((name) => [name, rename ? rename(name) : name]))
	const copy = (from: string, to: string): void => {
		mkdirSync(to, { recursive: true })
		for (const entry of readdirSync(from, { withFileTypes: true })) {
			const source = join(from, entry.name)
			if (entry.isDirectory()) {
				copy(source, join(to, entry.name))
				continue
			}
			if (/\.(d\.ts|d\.ts\.map|map)$/.test(entry.name) || /\.test\./.test(entry.name)) continue
			if (!entry.name.endsWith('.js')) {
				cpSync(source, join(to, entry.name))
				continue
			}
			let text = readFileSync(source, 'utf8')
			for (const [from2, to2] of map) if (from2 !== to2) text = text.replaceAll(from2, to2)
			const target = source.startsWith(chunks) ? (map.get(entry.name) ?? entry.name) : entry.name
			writeFileSync(join(to, target), text)
		}
	}
	copy(builtDist, join(into, 'dist'))
	const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
		string,
		unknown
	>
	manifest.version = version
	writeFileSync(join(into, 'package.json'), JSON.stringify(manifest))
	for (const folder of ['skills', 'assets']) {
		if (existsSync(join(packageRoot, folder)))
			cpSync(join(packageRoot, folder), join(into, folder), { recursive: true })
	}
	symlinkSync(join(packageRoot, 'node_modules'), join(into, 'node_modules'), 'dir')
	return into
}

/** What an install does to the folder: the old files go, the new ones are written. */
function replaceInstall(install: string, from: string): void {
	for (const entry of readdirSync(install)) {
		if (entry === 'node_modules') continue
		rmSync(join(install, entry), { recursive: true, force: true })
	}
	for (const entry of readdirSync(from)) {
		if (entry === 'node_modules') continue
		cpSync(join(from, entry), join(install, entry), { recursive: true })
	}
}

function run(
	install: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): { done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
	const child = spawn(process.execPath, [join(install, 'dist', 'bin.js'), ...args], {
		env,
		cwd: env.PROJECT,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (chunk) => {
		stdout += String(chunk)
	})
	child.stderr.on('data', (chunk) => {
		stderr += String(chunk)
	})
	return {
		done: new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr }))),
	}
}

function sessionIds(namzuHome: string): string[] {
	const projects = join(namzuHome, 'projects')
	if (!existsSync(projects)) return []
	return readdirSync(projects).flatMap((folder) =>
		readdirSync(join(projects, folder))
			.filter((name) => /^[0-9a-f-]{36}\.jsonl$/.test(name))
			.map((name) => name.replace(/\.jsonl$/, '')),
	)
}

describe.skipIf(!built)('a build replaced while a command runs from it', () => {
	beforeAll(async () => {
		work = mkdtempSync(join(tmpdir(), 'namzu-replaced-'))
		resetGate()
		model = createServer((request, response) => {
			let body = ''
			request.on('data', (chunk) => {
				body += String(chunk)
			})
			request.on('end', async () => {
				if (request.method === 'GET') {
					response.setHeader('content-type', 'application/json')
					response.end(
						JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o', object: 'model' }] }),
					)
					return
				}
				requests.push(body)
				if (requests.length === 1) {
					firstRequest()
					await firstGate
				}
				const chunk = (delta: object, finish: string | null = null) =>
					`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
				response.writeHead(200, { 'content-type': 'text/event-stream' })
				response.write(chunk({ role: 'assistant', content: '' }))
				response.write(chunk({ content: 'The fake model answered.' }))
				response.write(chunk({}, 'stop'))
				response.write(
					`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
				)
				response.write('data: [DONE]\n\n')
				response.end()
			})
		})
		await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
		port = (model.address() as AddressInfo).port
	})

	afterAll(async () => {
		await new Promise<void>((resolve) => model.close(() => resolve()))
		rmSync(work, { recursive: true, force: true })
	})

	it(
		'closes cleanly, keeps the conversation and resumes it with the new build',
		async () => {
			const old = stage(join(work, 'old'), '51.0.0')
			// A second build whose chunk files all have other names, as after a real release.
			const next = stage(join(work, 'next'), '51.0.1', (name) =>
				name.replace(/-([A-Z0-9]+)\.js$/, '-N$1.js'),
			)
			expect(
				readdirSync(join(old, 'dist', 'chunks')).some(
					(n) => !existsSync(join(next, 'dist', 'chunks', n)),
				),
			).toBe(true)

			const home = join(work, 'home')
			const project = join(work, 'project')
			mkdirSync(join(home, '.namzu'), { recursive: true })
			mkdirSync(project, { recursive: true })
			writeFileSync(
				join(home, '.namzu', 'trust.json'),
				JSON.stringify({ version: 1, trusted: [project] }),
			)
			const env: NodeJS.ProcessEnv = {
				HOME: home,
				USERPROFILE: home,
				NAMZU_HOME: join(home, '.namzu'),
				PATH: process.env.PATH,
				CI: 'true',
				NAMZU_PROVIDER: 'openai',
				NAMZU_MODEL: 'gpt-4o',
				OPENAI_API_KEY: 'x',
				OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
				NAMZU_AUTO_UPDATE: '0',
				NAMZU_UPDATE_CHECK: '0',
				PROJECT: project,
			}

			const first = run(old, ['exec', 'Remember the word pelican.'], env)
			// Either the model is asked (the usual order) or the command ended first, which is a failure to start.
			await Promise.race([
				firstSeen,
				first.done.then((ended) => {
					throw new Error(`the command ended before the model was asked: ${ended.stderr}`)
				}),
			])
			// The model is now working on the turn; the install changes under the running process.
			replaceInstall(old, next)
			expect(JSON.parse(readFileSync(join(old, 'package.json'), 'utf8')).version).toBe('51.0.1')
			releaseFirst()
			const finished = await first.done

			expect(finished.stderr).not.toMatch(
				/ERR_MODULE_NOT_FOUND|Cannot find module|at .*node:internal/,
			)
			expect(finished.stdout).toContain('The fake model answered.')
			expect(finished.code).toBe(0)

			// Nothing was lost: the conversation is on disk and the new build resumes it.
			const [id] = sessionIds(join(home, '.namzu'))
			expect(id).toBeDefined()
			const second = await run(old, ['exec', '--resume', id as string, 'What was the word?'], env)
				.done
			expect(second.code).toBe(0)
			expect(requests.at(-1)).toContain('pelican')
		},
		TIMEOUT,
	)
})
