/** Pure rules behind the effort slider shader: no GL, no clock, so they test with fixed inputs. */

export type Rgb = readonly [number, number, number]

/** Moves `current` toward `target` by an exponential ease of time constant `tauMs`. */
export function stepToward(current: number, target: number, dtMs: number, tauMs = 110): number {
	if (!(dtMs > 0)) return current
	const next = current + (target - current) * (1 - Math.exp(-dtMs / tauMs))
	return Math.abs(target - next) < 0.0005 ? target : next
}

export function smoothstep(a: number, b: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
	return t * t * (3 - 2 * t)
}

/** The loop runs only while the panel is open, the document is visible and motion is allowed. */
export function shouldAnimate(state: {
	active: boolean
	reducedMotion: boolean
	hidden: boolean
}): boolean {
	return state.active && !state.reducedMotion && !state.hidden
}

/**
 * What paints the fill: the plain CSS fill when WebGL2 is missing or the context is gone, one
 * static shader frame under reduced motion, otherwise the animated surface.
 */
export type RenderPath = 'css' | 'static' | 'animated'
export function renderPath(state: {
	webgl: boolean
	contextLost: boolean
	reducedMotion: boolean
}): RenderPath {
	if (!state.webgl || state.contextLost) return 'css'
	return state.reducedMotion ? 'static' : 'animated'
}

/** Reads `#rgb`, `#rrggbb`, `rgb()` and `color(srgb …)` as 0..1 channels; null when unreadable. */
export function parseColor(input: string): Rgb | null {
	const text = input.trim().toLowerCase()
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)
	if (hex?.[1]) {
		const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
		const n = Number.parseInt(h, 16)
		return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
	}
	const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(text)
	if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255]
	const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text)
	if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])]
	return null
}

export function isLight(color: Rgb): boolean {
	return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2] > 0.5
}

/**
 * The ramp along the fill: deep green, teal, the brand accent (read from `--primary`), then a hot
 * end. `fringe` is the soft violet behind the thumb.
 */
export const EFFORT_PALETTE = {
	dark: {
		deep: [0.03, 0.34, 0.3],
		teal: [0.1, 0.72, 0.62],
		hot: [0.66, 1, 0.8],
		fringe: [0.55, 0.4, 0.95],
	},
	light: {
		deep: [0.1, 0.42, 0.32],
		teal: [0.1, 0.6, 0.52],
		hot: [0.14, 0.84, 0.36],
		fringe: [0.46, 0.3, 0.84],
	},
} as const satisfies Record<string, Record<string, Rgb>>

/** Tunable look, in one place so screenshots can be compared against numbers. */
export const EFFORT_PARAMS = {
	cellPx: 2,
	bloomSigmaPx: 15,
	staticTime: 4.2,
	/** Time constants (ms) of the uniform easing. */
	easeProgressMs: 70,
	easeLevelMs: 260,
	easeVisibleMs: 120,
} as const

/** What the shader is fed for a selected level (0..1 across the levels offered). */
export function effortUniforms(level: number) {
	const L = Math.min(1, Math.max(0, level))
	return {
		/** Calm at low, alive at high. */
		drift: 0.05 + 0.22 * L,
		sparkle: 0.012 + 0.07 * L,
		rise: 1.5 + 5 * L,
		/** A faint thumb pulse at the bottom, a real bloom only at the top levels. */
		bloom: Math.max(0.12, smoothstep(0.55, 1, L)),
		/** How far the warm end pulls into the ramp. */
		warmth: 0.2 + 0.8 * L,
	}
}

/** Where the fill ends, in device px, inside a control whose padding keeps the thumb off the ends. */
export function fillEnd(width: number, pad: number, progress: number): number {
	return pad + Math.min(1, Math.max(0, progress)) * Math.max(0, width - pad * 2)
}
