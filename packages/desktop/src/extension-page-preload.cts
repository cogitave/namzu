import { contextBridge, ipcRenderer, webFrame } from 'electron'

/**
 * The only script with any privilege in an extension's page, written and shipped by Namzu. It runs in the
 * isolated world and gives the page one frozen object, `namzu`: a way to call the methods its manifest
 * declares, to hear what Namzu tells it, and the bridge version. It imports nothing but `contextBridge`,
 * `ipcRenderer` and `webFrame` (to insert the theme variables) and exposes none of them: the page gets no
 * `require`, no `process`, no `ipcRenderer`, no `Buffer` and no `webFrame`.
 *
 * Whether a call comes from a real click or key press is read here, in this world, at call time from the
 * page's own user-activation state; a page's script cannot write the stamp.
 */

const VERSION = 1

// @webrtc-close-begin
/**
 * Runs in the page's own world. Each constructor is replaced by a non-writable, non-configurable
 * `undefined`, so `new RTCPeerConnection()` throws a TypeError and the page cannot put it back.
 */
const CLOSE_WEBRTC = `(() => {
	const names = [
		'RTCPeerConnection',
		'webkitRTCPeerConnection',
		'RTCDataChannel',
		'RTCSessionDescription',
		'RTCIceCandidate',
		'RTCRtpSender',
		'RTCRtpReceiver',
		'RTCRtpTransceiver',
		'RTCSctpTransport',
		'RTCDtlsTransport',
		'RTCIceTransport',
	];
	for (const n of names) {
		try {
			delete window[n];
			Object.defineProperty(window, n, { value: undefined, writable: false, configurable: false });
		} catch (e) {}
	}
})();`
// @webrtc-close-end

if (process.argv.includes('--namzu-ext-no-network=1')) {
	void webFrame.executeJavaScript(CLOSE_WEBRTC)
}

type Handler = (data: unknown) => void
const handlers = new Map<string, Set<Handler>>()
let counter = 0
let themeKey: string | undefined

const TOKEN_NAMES = [
	'--ns-bg',
	'--ns-surface',
	'--ns-fg',
	'--ns-muted',
	'--ns-border',
	'--ns-accent',
	'--ns-font',
	'--ns-radius',
]

/** Namzu's tokens as CSS variables, replaced on every theme change. Using them is optional. */
function applyTheme(data: unknown): void {
	const tokens = (data as { tokens?: Record<string, unknown> } | null)?.tokens
	if (!tokens || typeof tokens !== 'object') return
	const css = TOKEN_NAMES.filter((k) => typeof tokens[k] === 'string')
		.map((k) => `${k}: ${String(tokens[k]).replace(/[;{}<>]/g, '')};`)
		.join(' ')
	if (themeKey) webFrame.removeInsertedCSS(themeKey)
	themeKey = webFrame.insertCSS(`:root { ${css} }`)
}

ipcRenderer.on('namzu-ext:event', (_event, message: unknown) => {
	const m = message as { v?: number; ev?: unknown; d?: unknown } | null
	if (!m || m.v !== VERSION || typeof m.ev !== 'string') return
	if (m.ev === 'theme') applyTheme(m.d)
	for (const h of handlers.get(m.ev) ?? []) {
		try {
			h(m.d)
		} catch {
			// a page's own handler failing is the page's business
		}
	}
})

const call = async (method: unknown, params?: unknown): Promise<unknown> => {
	if (typeof method !== 'string') throw new TypeError('method must be text')
	const reply = (await ipcRenderer.invoke('namzu-ext:call', {
		v: VERSION,
		id: ++counter,
		m: method,
		p: params ?? null,
		a: navigator.userActivation?.isActive === true,
	})) as { ok: true; r: unknown } | { ok: false; e: { code: string; message: string } } | undefined
	if (!reply) throw Object.assign(new Error('This page was stopped.'), { code: 'closed' })
	if (reply.ok) return reply.r
	throw Object.assign(new Error(reply.e.message), { code: reply.e.code })
}

contextBridge.exposeInMainWorld(
	'namzu',
	Object.freeze({
		version: VERSION,
		call,
		on: (event: string, handler: Handler) => {
			if (typeof event !== 'string' || typeof handler !== 'function') return
			let set = handlers.get(event)
			if (!set) {
				set = new Set()
				handlers.set(event, set)
			}
			set.add(handler)
		},
		off: (event: string, handler: Handler) => {
			handlers.get(event)?.delete(handler)
		},
	}),
)
