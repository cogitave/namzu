import type { DisplayInfo, Point, Rect } from '../../types/computer-use/index.js'

/**
 * One screenshot the model was shown: its id, the size of the image it saw,
 * and the display that image was made from. Every coordinate the model sends
 * is read against one of these.
 */
export interface ScreenshotFrame {
	/** `s1`, `s2`, … in the order the tool returned them. */
	readonly id: string
	readonly imageWidth: number
	readonly imageHeight: number
	/** Physical size and virtual-desktop origin of what the image shows. */
	readonly display: DisplayInfo
}

/**
 * The frames this tool instance has returned, newest last. A model reads a
 * coordinate off the screenshot in front of it, which is almost always the
 * latest; `get(id)` covers the one that names an earlier screenshot, and a
 * display whose resolution changed in between is mapped through the frame
 * the model actually looked at.
 */
export class ScreenshotFrames {
	private readonly frames = new Map<string, ScreenshotFrame>()
	private counter = 0
	private newest: ScreenshotFrame | undefined

	constructor(private readonly capacity = 32) {}

	record(image: { width: number; height: number }, display: DisplayInfo): ScreenshotFrame {
		this.counter += 1
		const frame: ScreenshotFrame = {
			id: `s${this.counter}`,
			imageWidth: image.width,
			imageHeight: image.height,
			display,
		}
		this.frames.set(frame.id, frame)
		this.newest = frame
		while (this.frames.size > this.capacity) {
			const oldest = this.frames.keys().next().value
			if (oldest === undefined) break
			this.frames.delete(oldest)
		}
		return frame
	}

	latest(): ScreenshotFrame | undefined {
		return this.newest
	}

	get(id: string): ScreenshotFrame | undefined {
		return this.frames.get(id)
	}
}

/** A display for a capture from a host that does not report one. */
export function assumedDisplay(width: number, height: number): DisplayInfo {
	return { id: 'default', x: 0, y: 0, width, height, scaleFactor: 1, primary: true }
}

/**
 * Whether `point` lies on the frame's image. The far edge is admitted — a
 * model aiming at the last column sometimes says `width` — and is clamped in
 * {@link toDisplayPoint}; anything further out is a coordinate read off some
 * other image, and acting on it would click somewhere the model never saw.
 */
export function pointOnImage(frame: ScreenshotFrame, point: Point): boolean {
	return point.x >= 0 && point.y >= 0 && point.x <= frame.imageWidth && point.y <= frame.imageHeight
}

function axisToDisplay(value: number, image: number, display: number): number {
	// The centre of image pixel `value`, in display pixels: unbiased, where
	// `value * scale` would lean every click half an image pixel up and left.
	const mapped = Math.floor(((value + 0.5) * display) / image)
	return Math.min(Math.max(mapped, 0), display - 1)
}

function axisToImage(value: number, display: number, image: number): number {
	const mapped = Math.floor(((value + 0.5) * image) / display)
	return Math.min(Math.max(mapped, 0), image - 1)
}

/**
 * A model coordinate (pixels of the frame's image) as the display-relative
 * physical pixel the host acts on. Every image pixel maps to the display
 * pixel at its centre, and {@link toImagePoint} maps that pixel straight
 * back, so a round trip is exact whenever the image is no larger than the
 * display.
 */
export function toDisplayPoint(frame: ScreenshotFrame, point: Point): Point {
	return {
		x: axisToDisplay(point.x, frame.imageWidth, frame.display.width),
		y: axisToDisplay(point.y, frame.imageHeight, frame.display.height),
	}
}

/** A display-relative physical pixel as the image pixel of `frame` that shows it. */
export function toImagePoint(frame: ScreenshotFrame, point: Point): Point {
	return {
		x: axisToImage(point.x, frame.display.width, frame.imageWidth),
		y: axisToImage(point.y, frame.display.height, frame.imageHeight),
	}
}

/**
 * An image-space rectangle as the display-relative physical rectangle that
 * covers it completely (outward rounding), clamped to the display. Null when
 * nothing of it is on the display.
 */
export function toDisplayRect(frame: ScreenshotFrame, rect: Rect): Rect | null {
	const sx = frame.display.width / frame.imageWidth
	const sy = frame.display.height / frame.imageHeight
	const left = Math.max(0, Math.floor(rect.x * sx))
	const top = Math.max(0, Math.floor(rect.y * sy))
	const right = Math.min(frame.display.width, Math.ceil((rect.x + rect.width) * sx))
	const bottom = Math.min(frame.display.height, Math.ceil((rect.y + rect.height) * sy))
	if (right <= left || bottom <= top) return null
	return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Virtual-desktop bounds (a window's) as the part of them visible in
 * `frame`'s image, in its pixels; null when none of it is on that display.
 */
export function desktopRectOnImage(frame: ScreenshotFrame, bounds: Rect): Rect | null {
	const { display } = frame
	const left = Math.max(bounds.x - display.x, 0)
	const top = Math.max(bounds.y - display.y, 0)
	const right = Math.min(bounds.x + bounds.width - display.x, display.width)
	const bottom = Math.min(bounds.y + bounds.height - display.y, display.height)
	if (right <= left || bottom <= top) return null
	const sx = frame.imageWidth / display.width
	const sy = frame.imageHeight / display.height
	const x = Math.floor(left * sx)
	const y = Math.floor(top * sy)
	return {
		x,
		y,
		width: Math.max(1, Math.ceil(right * sx) - x),
		height: Math.max(1, Math.ceil(bottom * sy) - y),
	}
}
