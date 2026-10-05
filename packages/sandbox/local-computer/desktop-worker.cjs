const http = require('node:http')
const { execFile } = require('node:child_process')
const { createHash, timingSafeEqual } = require('node:crypto')
const { createConnection } = require('node:net')

const STREAM_MAX_PAYLOAD = 64 * 1024
const STREAM_MAX_VIEWERS = 4

/** Probe the actual guest RFB server, not merely a listening TCP socket. */
function probeVnc(connect) {
	return new Promise((resolve) => {
		const socket = connect()
		let banner = Buffer.alloc(0)
		let settled = false
		const finish = (ready) => {
			if (settled) return
			settled = true
			socket.destroy()
			resolve(ready)
		}
		socket.setTimeout(2_000, () => finish(false))
		socket.on('error', () => finish(false))
		socket.on('close', () => finish(false))
		socket.on('data', (data) => {
			banner = Buffer.concat([banner, data.subarray(0, 12 - banner.length)])
			if (banner.length === 12) finish(/^RFB 003\.00[378]\n$/.test(banner.toString('ascii')))
		})
	})
}

function attachScreenStream(server, authorized, connect) {
	const { WebSocketServer, createWebSocketStream } = require('ws')
	const websocketServer = new WebSocketServer({
		noServer: true,
		perMessageDeflate: false,
		maxPayload: STREAM_MAX_PAYLOAD,
		maxBufferedChunks: 32,
		maxFragments: 32,
	})
	const viewers = new Set()
	server.on('upgrade', (req, socket, head) => {
		const refused = !authorized(req)
			? 401
			: req.method !== 'GET' || req.url !== '/stream'
				? 404
				: viewers.size >= STREAM_MAX_VIEWERS
					? 503
					: undefined
		if (refused) {
			socket.end(`HTTP/1.1 ${refused} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
			return
		}
		websocketServer.handleUpgrade(req, socket, head, (websocket) => {
			let guest
			try {
				guest = connect()
			} catch {
				websocket.terminate()
				return
			}
			let closed = false
			const close = () => {
				if (closed) return
				closed = true
				viewers.delete(close)
				guest.destroy()
				stream.destroy()
				websocket.terminate()
			}
			viewers.add(close)
			websocket.on('error', close)
			websocket.on('close', close)
			websocket.on('message', (_data, binary) => {
				if (!binary) close()
			})
			const stream = createWebSocketStream(websocket, {
				highWaterMark: STREAM_MAX_PAYLOAD,
			})
			stream.on('error', close)
			stream.on('close', close)
			guest.on('error', close)
			guest.on('close', close)
			guest.setTimeout(2_000, close)
			guest.once('connect', () => guest.setTimeout(0))
			// Duplex pipes propagate backpressure instead of retaining whole frames.
			// The target is an independently enforced view-only x11vnc server.
			stream.pipe(guest)
			guest.pipe(stream)
		})
	})
	const closeViewers = () => {
		for (const close of viewers) close()
	}
	const closeServer = server.close.bind(server)
	server.close = (callback) => {
		// HTTP close waits for upgraded sockets, so retire them before waiting
		// for its close event. Waiting until that event would deadlock shutdown.
		closeViewers()
		return closeServer(callback)
	}
	server.on('close', () => {
		closeViewers()
		websocketServer.close()
	})
}

const BUTTONS = { left: '1', middle: '2', right: '3' }
const SCROLL = { up: '4', down: '5', left: '6', right: '7' }
const KEY_NAMES = {
	CTRL: 'ctrl',
	CONTROL: 'ctrl',
	ALT: 'alt',
	SHIFT: 'shift',
	META: 'Super_L',
	SUPER: 'Super_L',
	ENTER: 'Return',
	RETURN: 'Return',
	ESC: 'Escape',
	ESCAPE: 'Escape',
	BACKSPACE: 'BackSpace',
	DELETE: 'Delete',
	SPACE: 'space',
	TAB: 'Tab',
	ARROWUP: 'Up',
	ARROWDOWN: 'Down',
	ARROWLEFT: 'Left',
	ARROWRIGHT: 'Right',
	PAGEUP: 'Prior',
	PAGEDOWN: 'Next',
}
const HELD_KEYS = new Set([
	'Control_L',
	'Alt_L',
	'Shift_L',
	'Super_L',
	'Return',
	'Escape',
	'BackSpace',
	'Delete',
	'Up',
	'Down',
	'Left',
	'Right',
	'Home',
	'End',
	'Prior',
	'Next',
	'Insert',
	'Tab',
	'space',
	'minus',
	'equal',
	'period',
	'comma',
	'slash',
	'backslash',
	'semicolon',
	'apostrophe',
	'bracketleft',
	'bracketright',
	'grave',
])
function heldKey(value) {
	const alias = KEY_NAMES[value.toUpperCase()] ?? value
	const key =
		alias === 'ctrl'
			? 'Control_L'
			: alias === 'alt'
				? 'Alt_L'
				: alias === 'shift'
					? 'Shift_L'
					: /^[A-Z]$/.test(alias)
						? alias.toLowerCase()
						: alias
	// xdotool supports command chaining; a syntactically safe word is not necessarily a keysym.
	if (!HELD_KEYS.has(key) && !/^(?:[a-z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key))
		throw new Error('Unsupported held keysym')
	return key
}

function run(binary, args) {
	return new Promise((resolve, reject) => {
		const env = { ...process.env }
		for (const key of Object.keys(env)) if (key.startsWith('NAMZU_SANDBOX_')) delete env[key]
		execFile(
			binary,
			args,
			{ env, encoding: 'buffer', maxBuffer: 24 * 1024 * 1024, timeout: 10_000 },
			(error, stdout) =>
				error ? reject(new Error('Guest desktop command failed')) : resolve(stdout),
		)
	})
}

function integer(value, low, high) {
	if (!Number.isSafeInteger(value) || value < low || value > high)
		throw new Error('Invalid desktop coordinate or amount')
	return String(value)
}

function point(value, geometry) {
	if (!value || typeof value !== 'object') throw new Error('Missing desktop coordinate')
	return [integer(value.x, 0, geometry.width - 1), integer(value.y, 0, geometry.height - 1)]
}

function pngGeometry(data) {
	if (data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a')
		throw new Error('Guest capture did not return PNG')
	return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

/** argv only; no shell parsing and no host desktop adapter. */
function actionArguments(action, geometry) {
	switch (action.type) {
		case 'mouse_move':
			return ['mousemove', ...point(action.to, geometry)]
		case 'mouse_click': {
			if (!Object.hasOwn(BUTTONS, action.button)) throw new Error('Invalid desktop button')
			return ['mousemove', ...point(action.at, geometry), 'click', BUTTONS[action.button]]
		}
		case 'mouse_drag': {
			if (!Object.hasOwn(BUTTONS, action.button)) throw new Error('Invalid desktop button')
			return [
				'mousemove',
				...point(action.from, geometry),
				'mousedown',
				BUTTONS[action.button],
				'mousemove',
				...point(action.to, geometry),
				'mouseup',
				BUTTONS[action.button],
			]
		}
		case 'scroll': {
			if (!SCROLL[action.direction]) throw new Error('Invalid scroll direction')
			return [
				'mousemove',
				...point(action.at, geometry),
				'click',
				'--repeat',
				integer(action.amount, 1, 100),
				'--delay',
				'20',
				SCROLL[action.direction],
			]
		}
		case 'type_text': {
			if (
				typeof action.text !== 'string' ||
				action.text.length > 100_000 ||
				action.text.includes('\0')
			)
				throw new Error('Invalid desktop text')
			return ['type', '--clearmodifiers', '--delay', '0', '--', action.text]
		}
		case 'key': {
			if (
				typeof action.keys !== 'string' ||
				action.keys.length > 100 ||
				!/^[a-zA-Z0-9_+ -]+$/.test(action.keys)
			)
				throw new Error('Invalid desktop key')
			return [
				'key',
				'--clearmodifiers',
				'--',
				action.keys
					.split('+')
					.map((key) => KEY_NAMES[key.toUpperCase()] ?? key)
					.join('+'),
			]
		}
		default:
			throw new Error('Unsupported desktop action')
	}
}

function createDesktopServer(options) {
	if (!/^[a-zA-Z0-9_-]{16,}$/.test(options.token ?? ''))
		throw new Error('A per-allocation desktop token is required')
	const digest = createHash('sha256').update(options.token).digest()
	const authorized = (req) => {
		const authorization =
			typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
		const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
		return (
			req.headers.origin === undefined &&
			timingSafeEqual(digest, createHash('sha256').update(presented).digest())
		)
	}
	const connectVnc =
		options.connectVnc ?? (() => createConnection({ host: '127.0.0.1', port: 5900 }))
	const execute = options.run ?? run
	const fetchBrowser =
		options.fetchBrowser ??
		(async () => {
			const response = await fetch('http://127.0.0.1:9222/json/version', {
				signal: AbortSignal.timeout(2_000),
			})
			if (!response.ok) return false
			const result = await response.json()
			return (
				typeof result.Browser === 'string' &&
				result.Browser.includes('Chrome') &&
				typeof result.webSocketDebuggerUrl === 'string'
			)
		})
	const capture = async () => await execute('maim', ['-f', 'png'])
	const geometry = async () => {
		const value = (await execute('xdotool', ['getdisplaygeometry']))
			.toString('utf8')
			.trim()
			.split(/\s+/)
			.map(Number)
		if (
			!Number.isSafeInteger(value[0]) ||
			!Number.isSafeInteger(value[1]) ||
			value[0] <= 0 ||
			value[1] <= 0
		)
			throw new Error('Guest display is not ready')
		return { width: value[0], height: value[1] }
	}
	let queue = Promise.resolve()
	// Per-allocation and per-focus ownership. Never send a global keyup.
	const keyboards = new Map()
	const heldAction = async (action) => {
		const fields =
			action.type === 'release_keys' ? ['type', 'keyboardId'] : ['type', 'key', 'keyboardId']
		if (
			Object.keys(action).length !== fields.length ||
			!fields.every((field) => Object.hasOwn(action, field)) ||
			typeof action.keyboardId !== 'string' ||
			!/^[a-zA-Z0-9_-]{16,80}$/.test(action.keyboardId) ||
			(action.type !== 'release_keys' &&
				(typeof action.key !== 'string' || !/^[a-zA-Z0-9_]{1,40}$/.test(action.key)))
		)
			throw new Error('Invalid held keyboard input')
		const key = action.type === 'release_keys' ? undefined : heldKey(action.key)
		const owned = keyboards.get(action.keyboardId)
		const heldElsewhere = (candidate) =>
			[...keyboards].some(([id, keys]) => id !== action.keyboardId && keys.has(candidate))
		let args
		if (action.type === 'key_down') {
			if (owned?.has(key)) return
			if ((!owned && keyboards.size >= 16) || (owned?.size ?? 0) >= 32)
				throw new Error('Held keyboard limit exceeded')
			if (!heldElsewhere(key)) args = ['keydown', '--', key]
		} else if (action.type === 'key_up') {
			if (!owned?.has(key)) return
			if (!heldElsewhere(key)) args = ['keyup', '--', key]
		} else {
			if (!owned) return
			const releasing = [...owned].filter((candidate) => !heldElsewhere(candidate))
			if (releasing.length) args = ['keyup', '--', ...releasing]
		}
		if (args) {
			try {
				await execute('xdotool', args)
			} catch {
				return { outcome: 'unknown' }
			}
		}
		if (action.type === 'key_down') {
			const keys = owned ?? new Set()
			keys.add(key)
			keyboards.set(action.keyboardId, keys)
		} else if (action.type === 'key_up') {
			owned.delete(key)
			if (!owned.size) keyboards.delete(action.keyboardId)
		} else keyboards.delete(action.keyboardId)
	}
	const json = (res, status, body) => {
		res.writeHead(status, {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
			'x-content-type-options': 'nosniff',
		})
		res.end(JSON.stringify(body))
	}
	const server = http.createServer(async (req, res) => {
		if (!authorized(req)) {
			json(res, 401, { error: 'unauthorized' })
			return
		}
		if (req.method === 'GET' && req.url === '/readyz') {
			try {
				const display = await geometry()
				const screenshot = pngGeometry(await capture())
				const browserReady = await fetchBrowser()
				const streamReady = options.stream === true ? await probeVnc(connectVnc) : false
				if (
					!browserReady ||
					(options.stream === true && !streamReady) ||
					screenshot.width !== display.width ||
					screenshot.height !== display.height
				)
					throw new Error('Guest is not ready')
				json(res, 200, {
					protocol: 1,
					...display,
					browserReady: true,
					heldKeyboard: { version: 1 },
					...(streamReady ? { stream: { protocol: 'rfb' } } : {}),
				})
			} catch {
				json(res, 503, { error: 'desktop_not_ready' })
			}
			return
		}
		if (req.method !== 'POST' || req.url !== '/action') {
			json(res, 404, { error: 'not_found' })
			return
		}
		let body = ''
		try {
			for await (const chunk of req) {
				body += chunk.toString('utf8')
				if (body.length > 1024 * 1024) throw new Error('Request too large')
			}
			const action = JSON.parse(body)
			const perform = async () => {
				try {
					if (['key_down', 'key_up', 'release_keys'].includes(action.type)) {
						const result = await heldAction(action)
						json(res, 200, result ?? { type: 'ok' })
						return
					}
					if (action.type === 'screenshot') {
						json(res, 200, {
							type: 'screenshot',
							data: (await capture()).toString('base64'),
						})
						return
					}
					if (action.type === 'cursor_position') {
						const text = (await execute('xdotool', ['getmouselocation', '--shell'])).toString(
							'utf8',
						)
						const x = Number(text.match(/^X=(-?\d+)$/m)?.[1])
						const y = Number(text.match(/^Y=(-?\d+)$/m)?.[1])
						if (!Number.isFinite(x) || !Number.isFinite(y))
							throw new Error('Invalid cursor response')
						json(res, 200, { type: 'cursor_position', point: { x, y } })
						return
					}
					const args = actionArguments(action, await geometry())
					try {
						await execute('xdotool', args)
						json(res, 200, { type: 'ok' })
					} catch {
						json(res, 200, { outcome: 'unknown' })
					}
				} catch {
					json(res, 400, { error: 'invalid_or_unavailable_action' })
				}
			}
			queue = queue.then(perform, perform)
			await queue
		} catch {
			json(res, 400, { error: 'invalid_request' })
		}
	})
	if (options.stream === true) attachScreenStream(server, authorized, connectVnc)
	return server
}

module.exports = { createDesktopServer, actionArguments, pngGeometry }

if (require.main === module) {
	const server = createDesktopServer({
		token: process.env.NAMZU_SANDBOX_TOKEN,
		stream: true,
	})
	server.listen(2025, '0.0.0.0')
}
