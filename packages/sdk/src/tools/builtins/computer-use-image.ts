/**
 * Screenshot sizing for `computer_use`.
 *
 * A model sees a screenshot at some size and answers with coordinates in that
 * size. If the host sends a native 3440x1440 capture, the provider shrinks it
 * before the model looks (or, for some computer-use tool results, rejects
 * it), and every coordinate the model returns is in a space the host never
 * observed: clicks land systematically off target. So the tool shrinks each
 * capture itself, to the largest size the model takes without a further
 * resize, remembers that size, and maps coordinates back.
 *
 * The size rule is the vision encoder's published reference implementation
 * (`resizedSize`), ported line for line — it is a policy, not an image
 * operation. The pixels are
 * decoded, resampled and encoded by maintained packages: `fast-png` (PNG
 * codec) and `pica` (Lanczos-3 resampling, pure JS with a bundled WASM
 * kernel). Neither needs a native build, and both load only when a capture
 * actually has to change size.
 */

/** Patch edge of the vision encoder: an image costs ⌈w/28⌉ × ⌈h/28⌉ visual tokens. */
const PATCH_PX = 28

/**
 * The limits a screenshot is fitted to: neither padded edge above
 * `maxLongEdge`, and no more than `maxTiles` 28-pixel patches.
 */
export interface ScreenshotLimits {
	readonly maxLongEdge: number
	readonly maxTiles: number
}

/**
 * Every current vision model takes this without resizing it: the standard
 * tier's limits exactly, and well inside the `detail: "high"` budget of the
 * Responses wire (2048 px, 2 500 32-pixel patches). The default.
 */
export const STANDARD_SCREENSHOT_LIMITS: ScreenshotLimits = Object.freeze({
	maxLongEdge: 1568,
	maxTiles: 1568,
})

/**
 * The high-resolution tier some newer models accept. Use it only when every
 * model the session can reach is on that tier: a standard-tier model rejects
 * such a screenshot in a tool result, the Responses wire's `high` detail
 * shrinks anything over 2048 px, and a request carrying more than 20 images
 * caps every image at 2000 px.
 */
export const HIGH_RES_SCREENSHOT_LIMITS: ScreenshotLimits = Object.freeze({
	maxLongEdge: 2576,
	maxTiles: 4784,
})

export interface ImageSize {
	readonly width: number
	readonly height: number
}

function tiles(width: number, height: number): number {
	return Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX)
}

/** Python's `round()`: exact .5 ties go to the even neighbour, as the live API does. */
function roundTiesToEven(value: number): number {
	const floor = Math.floor(value)
	if (value - floor !== 0.5) return Math.round(value)
	return floor % 2 === 0 ? floor : floor + 1
}

/**
 * The largest aspect-preserving size within `limits`; the input unchanged
 * when it already fits. Never larger than the input.
 */
export function screenshotTargetSize(
	width: number,
	height: number,
	limits: ScreenshotLimits = STANDARD_SCREENSHOT_LIMITS,
): ImageSize {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
		throw new RangeError(`screenshot size must be positive integers, got ${width}x${height}`)
	const fits = (w: number, h: number): boolean =>
		Math.ceil(w / PATCH_PX) * PATCH_PX <= limits.maxLongEdge &&
		Math.ceil(h / PATCH_PX) * PATCH_PX <= limits.maxLongEdge &&
		tiles(w, h) <= limits.maxTiles
	if (fits(width, height)) return { width, height }
	if (height > width) {
		const transposed = screenshotTargetSize(height, width, limits)
		return { width: transposed.height, height: transposed.width }
	}
	const aspect = width / height
	let lo = 1 // always fits
	let hi = width // never fits
	while (lo + 1 < hi) {
		const mid = Math.floor((lo + hi) / 2)
		if (fits(mid, Math.max(roundTiesToEven(mid / aspect), 1))) lo = mid
		else hi = mid
	}
	return { width: lo, height: Math.max(roundTiesToEven(lo / aspect), 1) }
}

/** Width and height from a PNG's IHDR chunk, without decoding it. */
export function pngSize(data: Uint8Array): ImageSize {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	if (data.length < 24 || signature.some((byte, index) => data[index] !== byte))
		throw new Error('computer_use: the host returned a screenshot that is not a PNG')
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
	return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** 8-bit RGBA pixels, row-major, no padding. */
interface RgbaImage {
	readonly width: number
	readonly height: number
	readonly data: Uint8Array
}

type FastPng = typeof import('fast-png')
type PicaModule = typeof import('pica')

let codec: Promise<{ png: FastPng; resizer: InstanceType<PicaModule['Pica']> }> | undefined

function loadCodec(): Promise<{ png: FastPng; resizer: InstanceType<PicaModule['Pica']> }> {
	codec ??= Promise.all([import('fast-png'), import('pica')]).then(([png, picaModule]) => ({
		png,
		// No `ww`/`cib`: those are browser features (Web Workers,
		// createImageBitmap). In Node pica resizes on the calling thread.
		resizer: new picaModule.Pica({ features: ['js', 'wasm'] }),
	}))
	return codec
}

/** For each PNG channel count: where red, green, blue and alpha come from (-1: opaque). */
const CHANNEL_SOURCES: Readonly<Record<number, readonly [number, number, number, number]>> = {
	1: [0, 0, 0, -1],
	2: [0, 0, 0, 1],
	3: [0, 1, 2, -1],
	4: [0, 1, 2, 3],
}

async function decodeRgba(data: Uint8Array): Promise<RgbaImage> {
	const { png } = await loadCodec()
	const decoded = png.decode(data)
	const { width, height } = decoded
	let source: ArrayLike<number> = decoded.data
	let channels = decoded.channels
	let depth: number = decoded.depth
	if (decoded.palette) {
		source = png.convertIndexedToRgb(decoded)
		channels = decoded.palette[0]?.length ?? 3
		depth = 8
	}
	const sources = CHANNEL_SOURCES[channels]
	if ((depth !== 8 && depth !== 16) || !sources)
		throw new Error(
			`computer_use: cannot read a ${depth}-bit, ${channels}-channel PNG screenshot; hosts should capture 8-bit RGB or RGBA`,
		)
	// The common capture — 8-bit RGBA — is already the layout the resampler takes.
	if (depth === 8 && channels === 4 && !decoded.palette) {
		const bytes = decoded.data
		return { width, height, data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
	}
	// Everything else becomes 8-bit RGBA; 16-bit samples keep their high byte.
	// No per-pixel branches: this runs once per pixel of a whole display.
	const shift = depth === 16 ? 8 : 0
	const [r, g, b, a] = sources
	const pixels = width * height
	const rgba = new Uint8Array(pixels * 4)
	if (a < 0) rgba.fill(255)
	for (let i = 0, s = 0, d = 0; i < pixels; i += 1, s += channels, d += 4) {
		rgba[d] = (source[s + r] as number) >> shift
		rgba[d + 1] = (source[s + g] as number) >> shift
		rgba[d + 2] = (source[s + b] as number) >> shift
	}
	if (a >= 0)
		for (let i = 0, s = a, d = 3; i < pixels; i += 1, s += channels, d += 4)
			rgba[d] = (source[s] as number) >> shift
	return { width, height, data: rgba }
}

async function encodePng(image: RgbaImage): Promise<Buffer> {
	const { png } = await loadCodec()
	const { width, height, data } = image
	// An opaque capture (every desktop screenshot) is sent as RGB: a quarter
	// fewer bytes in every request that carries it.
	let opaque = true
	for (let i = 3; i < data.length; i += 4) {
		if (data[i] !== 255) {
			opaque = false
			break
		}
	}
	if (!opaque) return Buffer.from(png.encode({ width, height, data, channels: 4, depth: 8 }))
	const rgb = new Uint8Array(width * height * 3)
	for (let s = 0, d = 0; s < data.length; s += 4, d += 3) {
		rgb[d] = data[s] as number
		rgb[d + 1] = data[s + 1] as number
		rgb[d + 2] = data[s + 2] as number
	}
	return Buffer.from(png.encode({ width, height, data: rgb, channels: 3, depth: 8 }))
}

async function resizeRgba(image: RgbaImage, target: ImageSize): Promise<RgbaImage> {
	if (target.width === image.width && target.height === image.height) return image
	const { resizer } = await loadCodec()
	const data = await resizer.resizeBuffer({
		src: image.data,
		width: image.width,
		height: image.height,
		toWidth: target.width,
		toHeight: target.height,
		filter: 'lanczos3',
	})
	return { width: target.width, height: target.height, data }
}

function cropRgba(
	image: RgbaImage,
	rect: { x: number; y: number; width: number; height: number },
): RgbaImage {
	const data = new Uint8Array(rect.width * rect.height * 4)
	for (let row = 0; row < rect.height; row += 1) {
		const from = ((rect.y + row) * image.width + rect.x) * 4
		data.set(image.data.subarray(from, from + rect.width * 4), row * rect.width * 4)
	}
	return { width: rect.width, height: rect.height, data }
}

/** A PNG ready for the model, and the size it was made from. */
export interface FittedImage {
	readonly data: Buffer
	readonly width: number
	readonly height: number
	readonly sourceWidth: number
	readonly sourceHeight: number
}

/**
 * Fit a PNG capture to `limits`. A capture that already fits is returned
 * byte for byte, without being decoded.
 */
export async function fitPng(data: Buffer, limits: ScreenshotLimits): Promise<FittedImage> {
	const source = pngSize(data)
	const target = screenshotTargetSize(source.width, source.height, limits)
	if (target.width === source.width && target.height === source.height)
		return { data, ...target, sourceWidth: source.width, sourceHeight: source.height }
	const resized = await resizeRgba(await decodeRgba(data), target)
	return {
		data: await encodePng(resized),
		width: resized.width,
		height: resized.height,
		sourceWidth: source.width,
		sourceHeight: source.height,
	}
}

/**
 * Cut `rect` (pixels of `data`, already clamped to it) out of a PNG and fit
 * the piece to `limits`. Never enlarges: a small region stays at its native
 * size, which is still more detail than the downscaled screenshot showed.
 */
export async function cropAndFitPng(
	data: Buffer,
	rect: { x: number; y: number; width: number; height: number },
	limits: ScreenshotLimits,
): Promise<FittedImage> {
	const decoded = await decodeRgba(data)
	const piece = cropRgba(decoded, rect)
	const target = screenshotTargetSize(piece.width, piece.height, limits)
	const resized = await resizeRgba(piece, target)
	return {
		data: await encodePng(resized),
		width: resized.width,
		height: resized.height,
		sourceWidth: piece.width,
		sourceHeight: piece.height,
	}
}
