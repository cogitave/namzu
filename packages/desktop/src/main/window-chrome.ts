import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron'
import type {
	WindowAppearance,
	WindowChrome,
	WindowMenu,
	WindowMenuAnchor,
} from '../shared/protocol.js'

export const WINDOW_CHROME_HEIGHT = 32

export function windowChrome(platform: string): WindowChrome {
	return {
		platform:
			platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'other',
		height: WINDOW_CHROME_HEIGHT,
	}
}

export function windowCaptionColors(appearance: unknown): TitleBarOverlayOptions {
	if (appearance !== 'light' && appearance !== 'dark') throw new Error('Unknown window appearance.')
	return {
		color: appearance === 'dark' ? '#121212' : '#f4f4f4',
		symbolColor: appearance === 'dark' ? '#d4d4d4' : '#262626',
		height: WINDOW_CHROME_HEIGHT,
	}
}

export function windowChromeOptions(
	platform: string,
	appearance: WindowAppearance = 'dark',
): BrowserWindowConstructorOptions {
	return {
		titleBarStyle: 'hidden',
		titleBarOverlay: windowCaptionColors(appearance),
		...(platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 9 } } : {}),
	}
}

export function readWindowMenu(value: unknown): WindowMenu {
	if (value !== 'edit' && value !== 'view' && value !== 'window')
		throw new Error('Unknown window menu.')
	return value
}

// CSS coordinates must be converted to Electron's window coordinates when the
// renderer is zoomed. Only a bounded point is accepted, never a menu template.
export function readWindowMenuAnchor(
	value: unknown,
	{ width, height, zoom }: { width: number; height: number; zoom: number },
): WindowMenuAnchor {
	if (!value || typeof value !== 'object') throw new Error('Invalid window menu position.')
	const { x, y } = value as Record<string, unknown>
	if (
		typeof x !== 'number' ||
		typeof y !== 'number' ||
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		x < 0 ||
		y < 0 ||
		x * zoom > width ||
		y * zoom > height
	)
		throw new Error('Invalid window menu position.')
	return { x: Math.round(x * zoom), y: Math.round(y * zoom) }
}
