import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { NO_NETWORK_ARG } from './main/extension-ui/policy.js'

/**
 * The preload is a sandboxed script that may import nothing of ours, so the script it runs in the page's
 * own world is read out of its source and run here against a window that has the constructors.
 */
const source = readFileSync(new URL('../src/extension-page-preload.cts', import.meta.url), 'utf8')
const between =
	/\/\/ @webrtc-close-begin[\s\S]*?const CLOSE_WEBRTC = `([\s\S]*?)`\n\/\/ @webrtc-close-end/.exec(
		source,
	)
const script = between?.[1] ?? ''

function pageWindow() {
	const w: Record<string, unknown> = {}
	for (const n of [
		'RTCPeerConnection',
		'webkitRTCPeerConnection',
		'RTCDataChannel',
		'RTCIceCandidate',
	])
		w[n] = class {}
	w.window = w
	return w
}

describe('a page without a network cannot make a peer connection', () => {
	it('finds the script and the switch the preload reads', () => {
		expect(script).toContain('RTCPeerConnection')
		expect(source).toContain(`'${NO_NETWORK_ARG}'`)
	})
	it('removes the constructors, so constructing one throws', () => {
		const w = pageWindow()
		runInNewContext(script, w)
		expect(() => runInNewContext('new RTCPeerConnection()', w)).toThrow(/is not a constructor/)
		expect(() => runInNewContext('new webkitRTCPeerConnection()', w)).toThrow(
			/is not a constructor/,
		)
		expect(w.RTCDataChannel).toBeUndefined()
	})
	it('cannot be undone by the page', () => {
		const w = pageWindow()
		runInNewContext(script, w)
		expect(() =>
			runInNewContext(
				"'use strict'; Object.defineProperty(window, 'RTCPeerConnection', { value: class {} })",
				w,
			),
		).toThrow()
		expect(() => runInNewContext("'use strict'; window.RTCPeerConnection = class {}", w)).toThrow()
		expect(w.RTCPeerConnection).toBeUndefined()
	})
})
