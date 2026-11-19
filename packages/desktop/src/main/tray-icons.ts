import { TRAY_ICON_PNG } from './tray-icon-data.js'

export type TrayTheme = 'dark' | 'light'

/** One picture of the mark for a screen scale. */
export interface TrayRepresentation {
	scaleFactor: number
	/** Pixels on each side. */
	size: number
	png: Buffer
}

/**
 * The pictures Namzu's own tray mark is drawn from, one per screen scale the platform uses: Windows
 * draws the mark at 16 points (16, 20, 24 and 32 pixels at 100, 125, 150 and 200 percent), the other
 * systems at 24 points. The theme picks the tile that reads against the system's bar. Namzu's mark
 * carries nothing an extension adds: no dot and no extension rows.
 */
export function trayRepresentations(platform: string, theme: TrayTheme): TrayRepresentation[] {
	const sizes: [number, number][] =
		platform === 'win32'
			? [
					[1, 16],
					[1.25, 20],
					[1.5, 24],
					[2, 32],
				]
			: [
					[1, 24],
					[2, 48],
				]
	const set = TRAY_ICON_PNG[theme]
	return sizes.map(([scaleFactor, size]) => ({
		scaleFactor,
		size,
		png: Buffer.from(set[size] ?? '', 'base64'),
	}))
}

export function trayTheme(shouldUseDarkColors: boolean): TrayTheme {
	return shouldUseDarkColors ? 'dark' : 'light'
}
