const http = require('node:http')
const { execFile } = require('node:child_process')
const { createHash, timingSafeEqual } = require('node:crypto')

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
	const json = (res, status, body) => {
		res.writeHead(status, {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
			'x-content-type-options': 'nosniff',
		})
		res.end(JSON.stringify(body))
	}
	return http.createServer(async (req, res) => {
		const authorization =
			typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
		const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
		if (
			req.headers.origin ||
			!timingSafeEqual(digest, createHash('sha256').update(presented).digest())
		) {
			json(res, 401, { error: 'unauthorized' })
			return
		}
		if (req.method === 'GET' && req.url === '/readyz') {
			try {
				const display = await geometry()
				const screenshot = pngGeometry(await capture())
				const browserReady = await fetchBrowser()
				if (
					!browserReady ||
					screenshot.width !== display.width ||
					screenshot.height !== display.height
				)
					throw new Error('Guest is not ready')
				json(res, 200, { protocol: 1, ...display, browserReady: true })
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
}

module.exports = { createDesktopServer, actionArguments, pngGeometry }

if (require.main === module) {
	const server = createDesktopServer({
		token: process.env.NAMZU_SANDBOX_TOKEN,
	})
	server.listen(2025, '0.0.0.0')
}
