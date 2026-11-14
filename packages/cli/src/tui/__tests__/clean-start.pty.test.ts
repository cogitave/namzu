/**
 * The built command on a real pseudo-terminal: what the screen holds when `namzu` opens, when it is
 * left, and when it is opened a second time in the same terminal. The emulator on the other side is
 * pre-filled with shell lines, as a person's terminal is. No model is asked anything, nothing is
 * slept on: every wait is for the emulator to show the text the step produces, and the process's
 * own exit.
 *
 * It runs `dist/bin.js`, so the package is built before this file runs (CI builds first).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Terminal } from '@xterm/headless'
import { type IPty, spawn } from 'node-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const BIN = fileURLToPath(new URL('../../../dist/bin.js', import.meta.url))
const ESC = '\u001b'
const COLS = 100
const ROWS = 30
// A real subprocess starting the whole command is legitimately slow on a loaded machine; what each
// step waits for is the emulator, so the budget is only a hang guard.
const SLOW_MS = 90_000

const root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-clean-start-')))
const home = join(root, 'home')
const project = join(root, 'project')
const entry = join(root, 'entry.mjs')
mkdirSync(home)
mkdirSync(project)
// Trust is the person's decision on first use; this test is about what the screen does around a session.
writeFileSync(join(home, 'trust.json'), JSON.stringify({ version: 1, trusted: [project] }))

let models: Server
let modelUrl = ''
beforeAll(async () => {
	// The provider's endpoint is a local list; any other host is refused, so nothing leaves the machine.
	models = createServer((request, response) => {
		response.setHeader('content-type', 'application/json')
		response.end(
			request.url?.endsWith('/models')
				? JSON.stringify({ object: 'list', data: [{ id: 'gpt-clean-1', object: 'model' }] })
				: '{}',
		)
	})
	await new Promise<void>((ready) => models.listen(0, '127.0.0.1', ready))
	modelUrl = `http://127.0.0.1:${(models.address() as AddressInfo).port}`
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
})
afterAll(async () => {
	await new Promise((done) => models.close(done))
	rmSync(root, { recursive: true, force: true })
})

class Screen {
	readonly term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true })
	raw = ''
	private readonly waiters: (() => void)[] = []
	private pty: IPty | undefined
	private exited: Promise<number> | undefined

	/** Text the shell printed before the command ran. */
	async shell(text: string): Promise<void> {
		await new Promise<void>((resolve) => this.term.write(text, resolve))
	}

	/** Every row held, scrollback first. */
	all(): string[] {
		const buffer = this.term.buffer.active
		const rows: string[] = []
		for (let i = 0; i < buffer.baseY + ROWS; i++)
			rows.push(buffer.getLine(i)?.translateToString(true) ?? '')
		return rows
	}

	/** The visible screen only. */
	visible(): string[] {
		return this.all().slice(-ROWS)
	}

	start(env: Record<string, string> = {}): void {
		const pty = spawn(process.execPath, [entry], {
			name: 'xterm-256color',
			cols: COLS,
			rows: ROWS,
			cwd: project,
			env: {
				PATH: process.env.PATH ?? '',
				HOME: root,
				NAMZU_HOME: home,
				TERM: 'xterm-256color',
				// CI markers in the child's environment must not stop the screen drawing live.
				CI: 'true',
				GITHUB_ACTIONS: 'true',
				OPENAI_API_KEY: 'not-a-secret',
				TEST_MODEL_URL: modelUrl,
				NAMZU_MODEL_CATALOGUE_REFRESH: '0',
				...env,
			},
		})
		this.pty = pty
		this.exited = new Promise((resolve) => pty.onExit(({ exitCode }) => resolve(exitCode)))
		pty.onData((data) => {
			this.raw += data
			this.term.write(data, () => {
				for (const wake of this.waiters.splice(0)) wake()
			})
		})
	}

	async until(ready: (rows: string[]) => boolean): Promise<void> {
		for (;;) {
			if (ready(this.visible())) return
			await new Promise<void>((resolve) => this.waiters.push(resolve))
		}
	}

	/** Ctrl+C twice, as a person leaves, and the wait for the process to end. */
	async leave(): Promise<number> {
		this.pty?.write('\u0003')
		await this.until((rows) => rows.some((row) => row.includes('again to exit')))
		this.pty?.write('\u0003')
		const code = (await this.exited) as number
		await this.shell('')
		return code
	}

	kill(): void {
		try {
			this.pty?.kill()
		} catch {
			// already gone
		}
	}
}

const banner = (row: string): boolean => row.includes('Namzu v')
const composerShown = (row: string): boolean =>
	row.includes('shift+tab to cycle') || row.includes('❯')
/** The banner and the input box are both drawn: the first frame comes before providers are found. */
const ready = (rows: string[]): boolean => rows.some(banner) && rows.some(composerShown)
const earlier = (row: string): boolean => row.startsWith('earlier shell line')

async function fill(t: Screen, label: string): Promise<void> {
	for (let i = 1; i <= 40; i++) await t.shell(`earlier shell line ${i}\r\n`)
	await t.shell(`$ ${label}\r\n`)
}

describe('opening the built command on a pseudo-terminal', () => {
	let t: Screen | undefined
	afterEach(() => t?.kill())

	it(
		'opens on a clean screen, leaves no box behind, and opens clean again, with the scrollback kept',
		async () => {
			t = new Screen()
			await fill(t, 'namzu')
			t.start()
			await t.until(ready)
			let visible = t.visible()
			// The banner is on the top row and nothing the shell printed is in view.
			expect(banner(visible[0] ?? '') || banner(visible[1] ?? '')).toBe(true)
			expect(visible.some(earlier)).toBe(false)
			expect(visible.some((row) => row.startsWith('$ namzu'))).toBe(false)
			// The scrollback is the person's: the shell's lines are all there, once, and it was never erased.
			expect(t.all().filter(earlier)).toHaveLength(40)
			expect(t.raw).not.toContain(`${ESC}[3J`)
			expect(t.raw).not.toContain(`${ESC}[2J`)

			expect(await t.leave()).toBe(0)
			// Leaving takes the input box and the footer off; the transcript (the banner) stays.
			visible = t.visible()
			expect(visible.some(banner)).toBe(true)
			expect(visible.some(composerShown)).toBe(false)
			expect(t.raw).not.toContain(`${ESC}[3J`)

			// The same terminal, a second time: one live banner on the top row, the first run above it.
			await t.shell('$ namzu again\r\n')
			t.start()
			await t.until(ready)
			visible = t.visible()
			expect(visible.filter(banner)).toHaveLength(1)
			expect(banner(visible[0] ?? '') || banner(visible[1] ?? '')).toBe(true)
			expect(visible.some((row) => row.startsWith('$ namzu'))).toBe(false)
			expect(t.all().filter(banner)).toHaveLength(2)
			expect(t.all().filter(earlier)).toHaveLength(40)
			expect(t.raw).not.toContain(`${ESC}[3J`)
			expect(await t.leave()).toBe(0)
		},
		SLOW_MS,
	)

	it(
		'fullscreen keeps its alternate screen and does not push the shell into the scrollback',
		async () => {
			t = new Screen()
			await fill(t, 'namzu')
			t.start({ NAMZU_FULLSCREEN: '1' })
			await t.until((rows) => rows.some((row) => row.includes('Namzu v')))
			expect(t.raw).toContain(`${ESC}[?1049h`)
			// The terminal's own screen is exactly as the shell left it, under the alternate screen.
			expect(t.raw.startsWith('\n'.repeat(ROWS))).toBe(false)
			expect(t.term.buffer.active.type).toBe('alternate')
		},
		SLOW_MS,
	)
})
