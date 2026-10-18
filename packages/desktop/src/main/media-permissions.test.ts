import { describe, expect, it, vi } from 'vitest'
import {
	type MediaPermissionPolicy,
	type PermissionSession,
	decideMediaCheck,
	decideMediaRequest,
	installMediaPermissions,
} from './media-permissions.js'

const PAGE = 'file:///app/dist/renderer/index.html'
const own = { id: 'own window' }
const other = { id: 'some other web contents' }

function policy(accepted: boolean): MediaPermissionPolicy {
	return {
		isOwnWindow: (webContents) => webContents === own,
		page: () => PAGE,
		accepted: () => accepted,
	}
}
const frame = { isMainFrame: true, requestingUrl: PAGE }

describe('the microphone request', () => {
	it('is granted for audio only, from an own window, after the person agreed', () => {
		expect(
			decideMediaRequest(policy(true), own, 'media', { ...frame, mediaTypes: ['audio'] }),
		).toBe(true)
	})
	it('is granted when the page URL carries a fragment or a differently spelled path', () => {
		for (const requestingUrl of [
			`${PAGE}#settings`,
			`${PAGE}?pane=2`,
			'file:///app/dist/renderer/../renderer/index.html',
		])
			expect(
				decideMediaRequest(policy(true), own, 'media', {
					isMainFrame: true,
					requestingUrl,
					mediaTypes: ['audio'],
				}),
			).toBe(true)
	})
	it('is denied for a malformed or missing page URL', () => {
		for (const requestingUrl of ['not a url', '', undefined])
			expect(
				decideMediaRequest(policy(true), own, 'media', {
					isMainFrame: true,
					requestingUrl,
					mediaTypes: ['audio'],
				}),
			).toBe(false)
	})
	it('is denied before the person agreed', () => {
		expect(
			decideMediaRequest(policy(false), own, 'media', { ...frame, mediaTypes: ['audio'] }),
		).toBe(false)
	})
	it.each([[['video']], [['audio', 'video']], [['video', 'audio']], [[]], [undefined]])(
		'is denied when the request is %j',
		(mediaTypes) => {
			expect(
				decideMediaRequest(policy(true), own, 'media', {
					...frame,
					mediaTypes: mediaTypes as never,
				}),
			).toBe(false)
		},
	)
	it('is denied for web contents that are not one of the main windows', () => {
		expect(
			decideMediaRequest(policy(true), other, 'media', { ...frame, mediaTypes: ['audio'] }),
		).toBe(false)
		expect(
			decideMediaRequest(policy(true), null, 'media', { ...frame, mediaTypes: ['audio'] }),
		).toBe(false)
	})
	it('is denied from a subframe or a page other than the app’s own', () => {
		expect(
			decideMediaRequest(policy(true), own, 'media', {
				isMainFrame: false,
				requestingUrl: PAGE,
				mediaTypes: ['audio'],
			}),
		).toBe(false)
		expect(
			decideMediaRequest(policy(true), own, 'media', {
				isMainFrame: true,
				requestingUrl: 'https://example.com/',
				mediaTypes: ['audio'],
			}),
		).toBe(false)
	})
})

describe('the microphone check', () => {
	it('answers true only for audio, an own window and consent', () => {
		expect(decideMediaCheck(policy(true), own, 'media', { ...frame, mediaType: 'audio' })).toBe(
			true,
		)
		expect(decideMediaCheck(policy(false), own, 'media', { ...frame, mediaType: 'audio' })).toBe(
			false,
		)
		expect(decideMediaCheck(policy(true), other, 'media', { ...frame, mediaType: 'audio' })).toBe(
			false,
		)
		expect(decideMediaCheck(policy(true), null, 'media', { ...frame, mediaType: 'audio' })).toBe(
			false,
		)
		expect(decideMediaCheck(policy(true), own, 'media', { ...frame, mediaType: 'video' })).toBe(
			false,
		)
		expect(decideMediaCheck(policy(true), own, 'media', { ...frame, mediaType: 'unknown' })).toBe(
			false,
		)
	})
})

describe('every other permission', () => {
	it.each([
		'notifications',
		'geolocation',
		'clipboard-read',
		'clipboard-sanitized-write',
		'fullscreen',
		'pointerLock',
		'openExternal',
		'display-capture',
		'midi',
		'unknown',
	])('%s is answered as before (granted) whatever the consent or the sender', (permission) => {
		for (const accepted of [true, false]) {
			expect(decideMediaRequest(policy(accepted), other, permission, {})).toBe(true)
			expect(decideMediaRequest(policy(accepted), null, permission, {})).toBe(true)
			expect(decideMediaCheck(policy(accepted), other, permission, {})).toBe(true)
		}
	})
})

describe('installation', () => {
	it('registers both handlers, and the request handler answers through its callback', () => {
		const handlers: {
			request?: Parameters<PermissionSession['setPermissionRequestHandler']>[0]
			check?: Parameters<PermissionSession['setPermissionCheckHandler']>[0]
		} = {}
		const session: PermissionSession = {
			setPermissionRequestHandler: (handler) => {
				handlers.request = handler
			},
			setPermissionCheckHandler: (handler) => {
				handlers.check = handler
			},
		}
		installMediaPermissions(session, policy(true))
		const answer = vi.fn()
		handlers.request?.(own, 'media', answer, { ...frame, mediaTypes: ['audio'] })
		handlers.request?.(own, 'media', answer, { ...frame, mediaTypes: ['audio', 'video'] })
		handlers.request?.(other, 'notifications', answer, {})
		expect(answer.mock.calls.map(([granted]) => granted)).toEqual([true, false, true])
		expect(handlers.check?.(own, 'media', 'file:///', { ...frame, mediaType: 'audio' })).toBe(true)
		expect(handlers.check?.(own, 'media', 'file:///', { ...frame, mediaType: 'video' })).toBe(false)
		expect(handlers.check?.(own, 'geolocation', 'file:///', {})).toBe(true)
	})
})
