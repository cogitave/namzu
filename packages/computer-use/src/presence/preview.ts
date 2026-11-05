/**
 * A development aid: the line that asks the presence helper to draw one state
 * of the overlay into a PNG file instead of onto the screen. It shows the
 * pointer (or, for `frame`, the border) on a mid-grey checker, a white and a
 * near-black panel, so the shadow and the transparency can be judged, and it
 * shows no window. The helper answers `{ ok: true, id, r: { path } }`.
 */

/** Display scales worth checking: 100 %, 150 % and 200 %. */
export const PREVIEW_DPIS = [96, 144, 192] as const
export type PreviewDpi = (typeof PREVIEW_DPIS)[number]

/**
 * What a preview draws: the pointer at rest, at the bottom of a click's dip,
 * with a click ripple half grown, or the frame around a window.
 */
export const PREVIEW_STATES = ['rest', 'press', 'ripple', 'frame'] as const
export type PreviewState = (typeof PREVIEW_STATES)[number]

export interface PreviewRequest {
	readonly dpi: PreviewDpi
	readonly state: PreviewState
	/** Where the helper writes the PNG, as the helper's own operating system names it. */
	readonly path: string
}

/** The helper's `preview` command as one line of input. Throws on a value the helper would refuse. */
export function previewCommandLine(request: PreviewRequest): string {
	if (!PREVIEW_DPIS.includes(request.dpi)) {
		throw new Error(`preview dpi must be one of ${PREVIEW_DPIS.join(', ')}`)
	}
	if (!PREVIEW_STATES.includes(request.state)) {
		throw new Error(`preview state must be one of ${PREVIEW_STATES.join(', ')}`)
	}
	if (request.path.trim() === '') throw new Error('preview needs a path')
	return JSON.stringify({
		cmd: 'preview',
		dpi: request.dpi,
		state: request.state,
		path: request.path,
	})
}
