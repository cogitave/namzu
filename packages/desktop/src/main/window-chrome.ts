import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron'
import type { WindowAppearance, WindowChrome } from '../shared/protocol.js'

// The window's own buttons end the header band, so they are as high as the band (`--frame-header-height`
// in theme.css; a test keeps the two equal).
export const WINDOW_CHROME_HEIGHT = 36

// The macOS buttons are 12 high and sit centred in the band.
const TRAFFIC_LIGHT_HEIGHT = 12
export const TRAFFIC_LIGHT_POSITION = {
	x: 12,
	y: (WINDOW_CHROME_HEIGHT - TRAFFIC_LIGHT_HEIGHT) / 2,
} as const

/**
 * Whether the header draws its own menu button. macOS keeps the system menu bar as the menu; the
 * other platforms have no menu bar, so the button stands in for it.
 */
export function drawsMenuButton(platform: string): boolean {
	return platform !== 'darwin'
}

// The window's own buttons are drawn in the sidebar's fill (`--chrome` is `--sidebar` in theme.css); a
// test keeps these in step with it, so they read as one band with the header.
export const WINDOW_CAPTION_FILL = { dark: '#121212', light: '#fbfbfb' } as const

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
		color: WINDOW_CAPTION_FILL[appearance],
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
		...(platform === 'darwin' ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION } : {}),
	}
}
