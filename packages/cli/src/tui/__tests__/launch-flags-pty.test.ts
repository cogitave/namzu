import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { type TerminalEvent, TerminalManager } from '../../terminal/manager.js'
import { loadHostPty } from '../../terminal/pty.js'

/**
 * The interactive TUI, started the way the desktop starts an engine terminal: in a
 * real pseudo-terminal, with the launch flags, against a local model list. What is
 * asserted is what a person would read on the screen, and that nothing was saved.
 */
const here = dirname(fileURLToPath(import.meta.url))
const BIN = join(here, '..', '..', '..', 'dist', 'bin.js')
let binding = true
try {
	await loadHostPty()
} catch {
	binding = false
}

const roots: string[] = []
const servers: Server[] = []
const managers: TerminalManager[] = []
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeAll()
	for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function modelServer(): Promise<string> {
	const server = createServer((request, response) => {
		response.setHeader('content-type', 'application/json')
		response.end(
			request.url?.endsWith('/models')
				? JSON.stringify({
						object: 'list',
						data: ['gpt-launch-1', 'gpt-launch-0'].map((id) => ({ id, object: 'model' })),
					})
				: '{}',
		)
	})
	servers.push(server)
	await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function launch(args: string[], preferences?: object) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-launch-flags-')))
	roots.push(root)
	const home = join(root, 'home')
	const project = join(root, 'project')
	mkdirSync(home)
	mkdirSync(project)
	// Trust is the person's decision on first use; this test is about what follows it.
	writeFileSync(join(home, 'trust.json'), JSON.stringify({ version: 1, trusted: [project] }))
	if (preferences) writeFileSync(join(home, 'preferences.json'), JSON.stringify(preferences))
	// The provider's endpoint is the local list; any other host is refused.
	const entry = join(root, 'entry.mjs')
	writeFileSync(
		entry,
		`const real = globalThis.fetch
globalThis.fetch = (input, init) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
	if (url.hostname === 'api.openai.com') {
		const next = new URL(process.env.TEST_MODEL_URL)
		next.pathname = url.pathname
		return real(next, init)
	}
	if (url.hostname === '127.0.0.1') return real(input, init)
	return Promise.reject(new Error('blocked: ' + url.host))
}
await import(${JSON.stringify(`file://${BIN}`)})
`,
	)
	const waiting: (() => void)[] = []
	const events: TerminalEvent[] = []
	const manager = new TerminalManager({
		loadPty: () => loadHostPty(),
		emit: (event) => {
			events.push(event)
			for (const wake of waiting.splice(0)) wake()
		},
		cwd: project,
	})
	managers.push(manager)
	const url = await modelServer()
	const info = await manager.create({
		command: process.execPath,
		args: [entry, ...args],
		env: {
			NAMZU_HOME: home,
			HOME: root,
			OPENAI_API_KEY: 'not-a-secret',
			TEST_MODEL_URL: url,
			NAMZU_MODEL_CATALOGUE_REFRESH: '0',
			ANTHROPIC_API_KEY: null,
			GEMINI_API_KEY: null,
			OPENROUTER_API_KEY: null,
		},
		cols: 120,
		rows: 30,
	})
	manager.attach({ terminalId: info.id, viewerId: 'test', writer: true, force: false })
	/** Wait, on the program's own output, until the rendered screen satisfies `done`. */
	const screenHas = async (done: (screen: string) => boolean): Promise<string> => {
		for (;;) {
			await manager.screenSettled(info.id)
			const screen = manager.screenLines(info.id).join('\n')
			if (done(screen)) return screen
			await new Promise<void>((resume) => waiting.push(resume))
		}
	}
	return { screenHas, home }
}

describe.skipIf(!binding || process.platform === 'win32')(
	'namzu launch flags in a real terminal',
	() => {
		it('starts on the chosen provider, model, effort and permission mode, and saves none of them', async () => {
			const { screenHas, home } = await launch([
				'--provider',
				'openai',
				'--model',
				'gpt-5',
				'--effort',
				'high',
				'--permission-mode',
				'plan',
			])
			const screen = await screenHas(
				(text) =>
					text.includes('MESSAGE') &&
					text.includes('gpt-5') &&
					text.includes('Plan (read-only)') &&
					text.includes('effort high'),
			)
			expect(screen).toContain('Plan (read-only)')
			expect(screen).toContain('effort high')
			expect(() => readFileSync(join(home, 'preferences.json'))).toThrow(/ENOENT/)
		}, 60_000)

		it('re-models a saved primary for one launch and leaves the file as it was', async () => {
			const saved = {
				version: 3,
				providers: [{ id: 'openai', model: 'gpt-launch-1' }],
				subagents: { active: [] },
			}
			const { screenHas, home } = await launch(['--model', 'gpt-launch-0'], saved)
			const screen = await screenHas(
				(text) => text.includes('MESSAGE') && text.includes('gpt-launch-0'),
			)
			expect(screen).not.toContain('gpt-launch-1')
			expect(JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8'))).toEqual(saved)
		}, 60_000)

		it('says so and offers the provider list when the provider is unknown', async () => {
			const { screenHas } = await launch(['--provider', 'nonesuch'])
			const screen = await screenHas(
				(text) =>
					text.includes('Choose a provider') && text.includes('Could not start with nonesuch'),
			)
			expect(screen).toContain('Could not start with nonesuch')
		}, 60_000)

		it('reports an effort the model does not offer and keeps the default', async () => {
			const { screenHas } = await launch([
				'--provider',
				'openai',
				'--model',
				'gpt-launch-0',
				'--effort',
				'high',
			])
			const screen = await screenHas((text) =>
				text.includes('--effort high is not offered by gpt-launch-0'),
			)
			expect(screen).toContain('--effort high is not offered by gpt-launch-0')
			expect(screen).not.toContain('effort high ·')
		}, 60_000)
	},
)
