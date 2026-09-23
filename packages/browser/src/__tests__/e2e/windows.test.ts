import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import {
	type WindowsCdpBrowserPlan,
	detectBrowserEnvironment,
	nodeBrowserProbes,
} from '../../detect.js'
import { PlaywrightBrowserHost } from '../../host.js'
import {
	WindowsBridgeError,
	WindowsCdpBridge,
	parseDevToolsActivePort,
} from '../../windows-bridge.js'
import {
	closeWindowsBrowser,
	connectWindowsBrowser,
	windowsBridgeEnv,
} from '../../windows-engine.js'
import { windowsPathToWsl } from '../../wsl.js'
import { type FixtureServer, startFixtureServer } from './fixture-server.js'

/**
 * The Windows engine on a real WSL machine: Windows PowerShell, Windows
 * Chrome (and Edge when installed), the fixture server reached from Windows
 * through WSL's localhost forwarding. Opt in with NAMZU_BROWSER_WSL_E2E=1;
 * NAMZU_BROWSER_WSL_E2E_HEADED=1 adds a visible-window run.
 *
 * Every profile it makes is `namzu-test-e2e-*` under
 * `%LOCALAPPDATA%\namzu\browser\profiles`, and is deleted afterwards. It never
 * attaches to, or stops, a browser it did not start.
 */
const E2E = process.env.NAMZU_BROWSER_WSL_E2E === '1'
const HEADED = E2E && process.env.NAMZU_BROWSER_WSL_E2E_HEADED === '1'

function windowsPlan(options: { headless: boolean; browser?: 'chrome' | 'msedge' }) {
	const plan = detectBrowserEnvironment(process.env, process.platform, nodeBrowserProbes, {
		engine: 'windows',
		headless: options.headless ? 'always' : 'never',
		...(options.browser ? { windowsBrowser: options.browser } : {}),
	})
	if (plan.engine !== 'windows-cdp' || plan.unavailableReason !== undefined) {
		throw new Error(`No Windows engine here: ${plan.unavailableReason ?? plan.engine}`)
	}
	return plan
}

/** Is a browser with remote debugging running on this profile? Asks without starting one. */
async function running(plan: WindowsCdpBrowserPlan, userDataDir: string): Promise<boolean> {
	try {
		const bridge = await WindowsCdpBridge.start({
			powershell: plan.powershell,
			env: windowsBridgeEnv(plan, process.env),
			params: {
				executable: plan.windowsExecutable,
				profile: 'unused',
				userDataDir,
				headless: true,
				closeOnExit: false,
				launchTimeoutMs: 5_000,
				attachOnly: true,
			},
		})
		await bridge.stop()
		return true
	} catch (error) {
		if (error instanceof WindowsBridgeError && error.code === 'not-running') return false
		throw error
	}
}

async function eventually(check: () => Promise<boolean>, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (await check()) return true
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	return false
}

function refOf(text: string, pattern: RegExp): string {
	const line = text.split('\n').find((l) => pattern.test(l))
	const ref = line ? /\[ref=([^\]]+)\]/.exec(line)?.[1] : undefined
	if (!ref) throw new Error(`no ref for ${pattern} in:\n${text}`)
	return ref
}

describe.skipIf(!E2E)('the Windows engine from WSL', { timeout: 120_000 }, () => {
	let plan: WindowsCdpBrowserPlan
	let server: FixtureServer
	let home: string
	let localAppData: string
	const profileDir = (name: string) => `${localAppData}\\namzu\\browser\\profiles\\${name}`

	beforeAll(async () => {
		plan = windowsPlan({ headless: true })
		localAppData = execFileSync(
			plan.powershell,
			['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write($env:LOCALAPPDATA)'],
			{ encoding: 'utf8', env: windowsBridgeEnv(plan, process.env) },
		).trim()
		server = await startFixtureServer()
		home = mkdtempSync(join(tmpdir(), 'namzu-browser-wsl-e2e-'))
	})

	afterAll(async () => {
		await server?.close()
		rmSync(home, { recursive: true, force: true })
		// Every profile this suite made, whichever test made it.
		const root = localAppData
			? windowsPathToWsl(`${localAppData}\\namzu\\browser\\profiles`, plan.mountRoot)
			: undefined
		if (root) {
			for (const name of readdirSync(root)) {
				if (/^namzu-test-e2e-[a-z0-9-]+$/.test(name)) {
					rmSync(join(root, name), { recursive: true, force: true })
				}
			}
		}
	})

	it('relays multi-megabyte messages both ways through PowerShell, however they are framed', async () => {
		// A CDP stand-in on WSL's 127.0.0.1, which Windows reaches through
		// localhost forwarding; the bridge finds it through DevToolsActivePort.
		const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 * 1024 })
		await new Promise((resolve) => wss.once('listening', resolve))
		const path = `/devtools/browser/${randomBytes(8).toString('hex')}`
		const received: string[] = []
		wss.on('connection', (ws, request) => {
			if (request.url !== path) return ws.close()
			ws.on('message', (data) => {
				const text = data.toString()
				received.push(text)
				const { id } = JSON.parse(text) as { id: number }
				const reply = Buffer.from(
					JSON.stringify({ id, result: { size: text.length, data: 'ü'.repeat(1_500_000) } }),
				)
				// Nine frames of uneven sizes for one message.
				const bounds = [0]
				for (let i = 1; i < 9; i++) bounds.push(Math.floor((i * reply.length) / 9) + (i % 3) * 7)
				bounds.push(reply.length)
				for (let i = 0; i < 9; i++) {
					ws.send(reply.subarray(bounds[i], bounds[i + 1]), { fin: i === 8 })
				}
			})
		})
		const dir = profileDir('namzu-test-e2e-framing')
		const local = windowsPathToWsl(dir, plan.mountRoot) as string
		mkdirSync(local, { recursive: true })
		writeFileSync(
			join(local, 'DevToolsActivePort'),
			`${(wss.address() as AddressInfo).port}\n${path}`,
		)
		const bridge = await WindowsCdpBridge.start({
			powershell: plan.powershell,
			env: windowsBridgeEnv(plan, process.env),
			params: {
				executable: plan.windowsExecutable,
				profile: 'namzu-test-e2e-framing',
				userDataDir: dir,
				headless: true,
				closeOnExit: true,
				launchTimeoutMs: 5_000,
				attachOnly: true,
			},
		})
		try {
			expect(bridge.ready.launched).toBe(false)
			const replies: string[] = []
			let wake: () => void = () => undefined
			bridge.onMessage((message) => {
				replies.push(message.toString('utf8'))
				wake()
			})
			const big = JSON.stringify({
				id: 1,
				params: { data: randomBytes(5 * 1024 * 1024).toString('base64') },
			})
			bridge.send(big)
			await new Promise<void>((resolve) => {
				wake = () => (replies.length >= 1 ? resolve() : undefined)
				wake()
			})
			expect(received[0] === big).toBe(true)
			const reply = JSON.parse(replies[0] ?? '') as {
				id: number
				result: { size: number; data: string }
			}
			expect(reply.id).toBe(1)
			expect(reply.result.size).toBe(big.length)
			expect(reply.result.data).toBe('ü'.repeat(1_500_000))
		} finally {
			await bridge.stop()
			await new Promise((resolve) => wss.close(resolve))
		}
	})

	async function drive(host: PlaywrightBrowserHost) {
		const origin = server.allowed
		const navigated = await host.observe({ action: 'navigate', url: `${origin}/index.html` })
		expect(navigated.page?.url).toBe(`${origin}/index.html`)
		const snapshot = await host.observe({ action: 'snapshot' })
		expect(snapshot.snapshot?.text).toMatch(/link "Order form" \[ref=/)
		const ref = refOf(snapshot.snapshot?.text ?? '', /link "Order form"/)
		const clicked = await host.act({ action: 'click', ref, origin, snapshot: true })
		expect(clicked.snapshot?.page.url).toBe(`${origin}/form.html`)
		expect(clicked.snapshot?.text).toMatch(/button "Place order"/)
		const shot = await host.observe({ action: 'screenshot' })
		expect(shot.screenshot?.mimeType).toBe('image/png')
		expect(shot.screenshot?.width).toBeGreaterThan(100)
		const full = await host.observe({ action: 'screenshot', fullPage: true })
		expect(full.screenshot?.data.length).toBeGreaterThan(1_000)
	}

	it('drives headless Windows Chrome: navigate, snapshot, click by ref, screenshot, then closes it', async () => {
		const name = 'namzu-test-e2e-headless'
		const host = new PlaywrightBrowserHost({
			home,
			plan,
			profile: name,
			sessionId: 'e2e',
			sites: { [server.allowed]: 'act', '*': 'ask' },
		})
		expect(host.capabilities.engine).toBe('windows-cdp')
		expect(host.capabilities.unavailableReason).toBeUndefined()
		try {
			await drive(host)
			const dir = profileDir(name)
			const port = parseDevToolsActivePort(
				readFileSync(
					join(windowsPathToWsl(dir, plan.mountRoot) as string, 'DevToolsActivePort'),
					'utf8',
				),
			)
			expect(port?.path).toMatch(/^\/devtools\/browser\//)
			const descriptor = JSON.parse(
				readFileSync(join(home, 'browser', 'profiles', `${name}.json`), 'utf8'),
			)
			expect(descriptor).toMatchObject({
				engine: 'windows-cdp',
				browser: 'chrome',
				userDataDir: dir,
			})
			expect(await running(plan, dir)).toBe(true)
		} finally {
			await host.dispose()
		}
		expect(await eventually(async () => !(await running(plan, profileDir(name))), 15_000)).toBe(
			true,
		)
	})

	it('refuses downloads in the Windows browser and says so', async () => {
		const host = new PlaywrightBrowserHost({
			home,
			plan,
			profile: 'namzu-test-e2e-download',
			sites: { [server.allowed]: 'act', '*': 'ask' },
		})
		try {
			await host.observe({ action: 'navigate', url: `${server.allowed}/download.html` })
			const text = (await host.observe({ action: 'snapshot' })).snapshot?.text ?? ''
			const result = await host.act({
				action: 'click',
				ref: refOf(text, /link "Get the report"/),
				origin: server.allowed,
			})
			expect(result.message).toContain('A download of "report.pdf" was cancelled')
		} finally {
			await host.dispose()
		}
	})

	it('shares the browser between two holders and closes it with the last', async () => {
		const name = 'namzu-test-e2e-shared'
		const options = { home, plan, profile: name, sites: { [server.allowed]: 'act' as const } }
		const first = new PlaywrightBrowserHost({ ...options, sessionId: 'one' })
		const second = new PlaywrightBrowserHost({ ...options, sessionId: 'two' })
		try {
			await first.observe({ action: 'navigate', url: `${server.allowed}/index.html` })
			await second.observe({ action: 'snapshot' })
			await first.dispose()
			expect(await running(plan, profileDir(name))).toBe(true)
			expect((await second.observe({ action: 'snapshot' })).snapshot?.text).toBeDefined()
		} finally {
			await first.dispose()
			await second.dispose()
		}
		expect(await eventually(async () => !(await running(plan, profileDir(name))), 15_000)).toBe(
			true,
		)
	})

	it('closes the browser it started when the bridge is killed, and keeps it when asked to', async () => {
		for (const keep of [false, true]) {
			const name = keep ? 'namzu-test-e2e-kill-keep' : 'namzu-test-e2e-kill'
			const dir = profileDir(name)
			const connection = await connectWindowsBrowser({
				plan,
				profile: name,
				userDataDir: dir,
				closeOnExit: !keep,
				env: process.env,
			})
			expect(connection.launched).toBe(true)
			const pid = connection.bridge.pid as number
			process.kill(pid, 'SIGKILL')
			await connection.bridge.exited
			if (keep) {
				await new Promise((resolve) => setTimeout(resolve, 3_000))
				expect(await running(plan, dir)).toBe(true)
				expect(await closeWindowsBrowser({ plan, profile: name, env: process.env }, dir)).toBe(true)
			}
			expect(await eventually(async () => !(await running(plan, dir)), 15_000)).toBe(true)
		}
	})

	it.skipIf(!existsSync('/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'))(
		'drives Microsoft Edge when asked for it',
		async () => {
			const edge = windowsPlan({ headless: true, browser: 'msedge' })
			expect(edge.browser).toBe('msedge')
			const host = new PlaywrightBrowserHost({
				home,
				plan: edge,
				profile: 'namzu-test-e2e-edge',
				sites: { [server.allowed]: 'act' },
			})
			try {
				await drive(host)
			} finally {
				await host.dispose()
			}
		},
	)

	it.skipIf(!HEADED)('drives a visible Windows Chrome window', async () => {
		const host = new PlaywrightBrowserHost({
			home,
			plan: windowsPlan({ headless: false }),
			profile: 'namzu-test-e2e-headed',
			sites: { [server.allowed]: 'act' },
		})
		expect(host.capabilities.headless).toBe(false)
		try {
			await drive(host)
		} finally {
			await host.dispose()
		}
	})
})
