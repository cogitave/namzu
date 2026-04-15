import { describe, expect, it } from 'vitest'
import { detectDisplayServer } from '../detect/index.js'

describe('detectDisplayServer', () => {
	it('returns darwin on macOS regardless of env', () => {
		expect(detectDisplayServer({}, 'darwin')).toBe('darwin')
		expect(detectDisplayServer({ DISPLAY: ':0' }, 'darwin')).toBe('darwin')
	})

	it('returns win32 on Windows', () => {
		expect(detectDisplayServer({}, 'win32')).toBe('win32')
	})

	it('prefers XDG_SESSION_TYPE on linux', () => {
		expect(detectDisplayServer({ XDG_SESSION_TYPE: 'wayland' }, 'linux')).toBe('wayland')
		expect(detectDisplayServer({ XDG_SESSION_TYPE: 'x11' }, 'linux')).toBe('x11')
		expect(detectDisplayServer({ XDG_SESSION_TYPE: 'WAYLAND' }, 'linux')).toBe('wayland')
	})

	it('falls back to WAYLAND_DISPLAY / DISPLAY when XDG_SESSION_TYPE is absent', () => {
		expect(detectDisplayServer({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe('wayland')
		expect(detectDisplayServer({ DISPLAY: ':0' }, 'linux')).toBe('x11')
		expect(detectDisplayServer({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'linux')).toBe(
			'wayland',
		)
	})

	it('returns unknown for headless linux or non-recognised platforms', () => {
		expect(detectDisplayServer({}, 'linux')).toBe('unknown')
		expect(detectDisplayServer({}, 'freebsd' as NodeJS.Platform)).toBe('unknown')
	})
})
