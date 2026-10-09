import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { type TerminalEvent, TerminalManager } from '../../terminal/manager.js'
import { loadHostPty } from '../../terminal/pty.js'

/**
 * The interactive TUI in a real pseudo-terminal that is resized while it runs, the way
 * the desktop's split pane resizes it. What is asserted is what a person would see: the
 * message box is redrawn to the new width, no line is longer than the pane, and the
 * footer keeps the model. Nothing here waits on a clock; each step waits on the
 * program's own output.
 */
const here = dirname(fileURLToPath(import.meta.url))
const BIN = join(here, '..', '..', '..', 'dist', 'bin.js')
const MODEL = 'claude-resize-1'
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

async function launch(cols: number) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-resize-')))
	roots.push(root)
	const home = join(root, 'home')
	const project = join(root, 'Documents', 'Namzu', 'New project 3')
	mkdirSync(home)
	mkdirSync(project, { recursive: true })
	writeFileSync(join(home, 'trust.json'), JSON.stringify({ version: 1, trusted: [project] }))
	writeFileSync(
		join(home, 'preferences.json'),
		JSON.stringify({
			version: 3,
			providers: [{ id: 'openai', model: MODEL }],
			subagents: { active: [] },
		}),
	)
	const server = createServer((request, response) => {
		response.setHeader('content-type', 'application/json')
		response.end(
			request.url?.endsWith('/models')
				? JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] })
				: '{}',
		)
	})
	servers.push(server)
	await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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
	const info = await manager.create({
		command: process.execPath,
		args: [entry],
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
		cols,
		rows: 24,
	})
	manager.attach({ terminalId: info.id, viewerId: 'test', writer: true, force: false })
	const screenHas = async (done: (lines: string[]) => boolean): Promise<string[]> => {
		for (;;) {
			await manager.screenSettled(info.id)
			const lines = manager.screenLines(info.id).map((line) => line.trimEnd())
			if (done(lines)) return lines
			await new Promise<void>((resume) => waiting.push(resume))
		}
	}
	const resize = (width: number) =>
		manager.resize({ terminalId: info.id, viewerId: 'test', cols: width, rows: 24 })
	return { screenHas, resize }
}

/**
 * The composer's frame has been drawn whole for exactly this pane width: the top and
 * bottom borders both span it and close with their corners, nothing on screen is wider
 * than the pane, and the footer is under it. The redraw arrives in several chunks, so a
 * screen can show the new bottom border and footer while the top border is still the old
 * width's; that frame is not yet the answer, and the wait goes on to the next output.
 */
function drawnFor(cols: number) {
	return (lines: string[]): boolean => {
		const top = lines.find((line) => line.trimStart().startsWith('┌'))
		const bottom = lines.find((line) => line.trimStart().startsWith('└'))
		const footer = lines.find((line) => line.includes('shift+tab'))
		return (
			top !== undefined &&
			bottom !== undefined &&
			top.endsWith('┐') &&
			bottom.endsWith('┘') &&
			[...top].length >= cols - 4 &&
			[...top].length === [...bottom].length &&
			lines.every((line) => [...line].length <= cols) &&
			footer !== undefined &&
			footer.includes(MODEL)
		)
	}
}

describe.skipIf(!binding || process.platform === 'win32')(
	'namzu redraws when its terminal is resized',
	() => {
		it('fits the message box and footer to each new width, wide to narrow and back, repeatedly', async () => {
			const { screenHas, resize } = await launch(100)
			await screenHas(drawnFor(100))
			for (const cols of [46, 40, 60, 80, 50, 120, 40, 120, 60, 80]) {
				resize(cols)
				const lines = await screenHas(drawnFor(cols))
				const longest = Math.max(...lines.map((line) => [...line].length))
				expect(longest, `${cols} columns`).toBeLessThanOrEqual(cols)
				const top = lines.find((line) => line.trimStart().startsWith('┌'))
				const bottom = lines.find((line) => line.trimStart().startsWith('└'))
				expect(top?.endsWith('┐'), `${cols} columns: the top-right corner`).toBe(true)
				expect([...(top ?? '')].length).toBe([...(bottom ?? '')].length)
			}
		}, 90_000)
	},
)
