const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { writeFileSync } = require('node:fs')
const { APPLICATIONS } = require('./app-catalog.cjs')
const { EXTENSION_ORIGIN } = require('./app-native-host.cjs')

const HOME_URL = `${EXTENSION_ORIGIN}home.html`
const NEW_TAB_URL = 'chrome://newtab/'
const MARKER_BASE = 'http://127.0.0.1:9222/namzu-home-bootstrap?id='
const READY_FILE = '/tmp/namzu-browser-home-ready'
const PRESENTED_HOME = `({url:location.href,ready:document.readyState,apps:document.getElementById('apps')?.children.length||0,clock:!!document.getElementById('clock')})`

class BrowserHomeError extends Error {
	constructor(code) {
		super(code)
		this.code = code
	}
}

function pause(signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new BrowserHomeError('home-startup-aborted'))
		const finish = (error) => {
			clearTimeout(timer)
			signal.removeEventListener('abort', abort)
			if (error) reject(error)
			else resolve()
		}
		const abort = () => finish(new BrowserHomeError('home-startup-aborted'))
		const timer = setTimeout(() => finish(), 100)
		signal.addEventListener('abort', abort, { once: true })
	})
}

async function listTargets(signal) {
	const response = await fetch('http://127.0.0.1:9222/json/list', { signal })
	if (!response.ok) throw new BrowserHomeError('browser-not-ready')
	const text = await response.text()
	if (text.length > 1024 * 1024) throw new BrowserHomeError('browser-target-list-too-large')
	const targets = JSON.parse(text)
	if (!Array.isArray(targets) || targets.length > 1000)
		throw new BrowserHomeError('browser-target-list-invalid')
	return targets
}

function request(target, method, params, signal) {
	let url
	try {
		url = new URL(target.webSocketDebuggerUrl)
	} catch {
		return Promise.reject(new BrowserHomeError('browser-target-invalid'))
	}
	if (
		url.protocol !== 'ws:' ||
		url.hostname !== '127.0.0.1' ||
		url.port !== '9222' ||
		url.username ||
		url.password ||
		url.pathname !== `/devtools/page/${target.id}` ||
		url.search ||
		url.hash
	)
		return Promise.reject(new BrowserHomeError('browser-target-invalid'))
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new BrowserHomeError('home-startup-aborted'))
		const socket = new WebSocket(url)
		let settled = false
		const finish = (error, result) => {
			if (settled) return
			settled = true
			signal.removeEventListener('abort', abort)
			socket.removeEventListener('open', open)
			socket.removeEventListener('message', message)
			socket.removeEventListener('error', lost)
			socket.removeEventListener('close', lost)
			// Undici reports closing an opening socket as an error event.
			socket.addEventListener('error', () => {}, { once: true })
			socket.close()
			if (error) reject(error)
			else resolve(result)
		}
		const abort = () => finish(new BrowserHomeError('home-startup-aborted'))
		const lost = () => finish(new BrowserHomeError('browser-target-disconnected'))
		const open = () => {
			try {
				socket.send(JSON.stringify({ id: 1, method, params }))
			} catch {
				finish(new BrowserHomeError('browser-command-refused'))
			}
		}
		const message = (event) => {
			try {
				const text = String(event.data)
				if (text.length > 65536) throw new Error('Bounded response required')
				const reply = JSON.parse(text)
				if (reply.id !== 1) return
				if (reply.error) finish(new BrowserHomeError('browser-command-refused'))
				else finish(undefined, reply.result)
			} catch {
				finish(new BrowserHomeError('browser-response-invalid'))
			}
		}
		signal.addEventListener('abort', abort, { once: true })
		socket.addEventListener('open', open, { once: true })
		socket.addEventListener('message', message)
		socket.addEventListener('error', lost, { once: true })
		socket.addEventListener('close', lost, { once: true })
	})
}

/** Bootstrap only the unique tab created by this launcher, never a restored tab. */
async function bootstrapBrowserHome(marker, options = {}) {
	if (!/^http:\/\/127\.0\.0\.1:9222\/namzu-home-bootstrap\?id=[a-f0-9]{32}$/.test(marker))
		throw new BrowserHomeError('browser-marker-invalid')
	const signal = options.signal ?? AbortSignal.timeout(15000)
	const list = options.listTargets ?? listTargets
	const command = options.request ?? request
	const delay = options.pause ?? pause
	let id
	let navigated = false
	let nativeNewTab = false
	while (!signal.aborted) {
		let targets
		try {
			targets = await list(signal)
		} catch {
			await delay(signal)
			continue
		}
		const target = targets.find((entry) =>
			id ? entry.type === 'page' && entry.id === id : entry.type === 'page' && entry.url === marker,
		)
		if (!target) {
			if (id) throw new BrowserHomeError('owned-home-tab-closed')
			await delay(signal)
			continue
		}
		id ??= target.id
		if (![marker, NEW_TAB_URL, HOME_URL].includes(target.url))
			throw new BrowserHomeError('owned-home-tab-navigated-away')
		if (navigated) {
			const result = await command(
				target,
				'Runtime.evaluate',
				{ expression: PRESENTED_HOME, returnByValue: true },
				signal,
			)
			const value = result?.result?.value
			if (
				value?.url === HOME_URL &&
				value.ready === 'complete' &&
				value.clock === true &&
				value.apps === APPLICATIONS.length
			) {
				if (nativeNewTab) return
				// Activate this trusted extension, then use Chromium's native route
				// for its New Tab virtual URL rather than leaving a literal address.
				await command(target, 'Page.navigate', { url: NEW_TAB_URL }, signal)
				nativeNewTab = true
				await delay(signal)
				continue
			}
			if (value?.url === HOME_URL) {
				await delay(signal)
				continue
			}
		}
		await command(target, 'Page.navigate', { url: nativeNewTab ? NEW_TAB_URL : HOME_URL }, signal)
		navigated = true
		await delay(signal)
	}
	throw new BrowserHomeError('home-startup-aborted')
}

function browserLaunchArguments(args, nonce = randomBytes(16).toString('hex')) {
	if (!/^[a-f0-9]{32}$/.test(nonce)) throw new BrowserHomeError('browser-marker-invalid')
	const homeRequested = args.at(-1) === NEW_TAB_URL
	const marker = `${MARKER_BASE}${nonce}`
	return { homeRequested, marker, args: homeRequested ? [...args.slice(0, -1), marker] : [...args] }
}

async function runBrowser(args) {
	const { homeRequested, marker, args: actualArgs } = browserLaunchArguments(args)
	const controller = new AbortController()
	const deadline = homeRequested ? setTimeout(() => controller.abort(), 15000) : undefined
	const child = spawn('/usr/bin/chromium', actualArgs, { stdio: 'inherit' })
	let ended = false
	const closed = new Promise((resolve, reject) => {
		child.once('error', () => {
			ended = true
			controller.abort()
			reject(new BrowserHomeError('browser-start-failed'))
		})
		child.once('close', (code) => {
			ended = true
			if (code !== 0) controller.abort()
			resolve(code ?? 1)
		})
	})
	void closed.catch(() => {})
	const stop = () => {
		controller.abort()
		if (!ended) child.kill('SIGTERM')
	}
	process.on('SIGTERM', stop)
	process.on('SIGINT', stop)
	try {
		if (homeRequested) {
			await bootstrapBrowserHome(marker, { signal: controller.signal })
			clearTimeout(deadline)
			if (process.env.NAMZU_BROWSER_HOME_READY === '1')
				writeFileSync(READY_FILE, 'ready\n', { flag: 'wx', mode: 0o600 })
		}
		return await closed
	} catch (error) {
		if (!ended) child.kill('SIGTERM')
		const retirement = setTimeout(() => {
			if (!ended) child.kill('SIGKILL')
		}, 2000)
		await closed.catch(() => {})
		clearTimeout(retirement)
		throw error
	} finally {
		clearTimeout(deadline)
		process.removeListener('SIGTERM', stop)
		process.removeListener('SIGINT', stop)
	}
}

module.exports = {
	HOME_URL,
	NEW_TAB_URL,
	MARKER_BASE,
	READY_FILE,
	bootstrapBrowserHome,
	browserLaunchArguments,
	request,
}
if (require.main === module)
	void runBrowser(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code
		},
		(error) => {
			const reason = error instanceof BrowserHomeError ? error.code : 'home-startup-failed'
			process.stderr.write(`Namzu browser home startup failed: ${reason}\n`)
			process.exitCode = 1
		},
	)
