/**
 * Bring an image inside what a provider accepts before it is attached.
 *
 * A provider refuses an image that is too wide, too tall or too many bytes,
 * and it refuses it on every later turn, because the history carries it. So
 * the limits are applied once, here, at the door: an image inside them passes
 * through byte for byte; one outside is shrunk, and one that cannot be shrunk
 * is refused with a sentence the operator can act on.
 *
 * Shrinking needs an image library. That library (`sharp`) is an optional
 * dependency loaded on first use, so the CLI starts and works without it:
 * without it an image already inside the limits is attached, and one outside
 * is refused.
 */

export interface ImageLimits {
	readonly maxWidth: number
	readonly maxHeight: number
	/** The most base64 text one image may become. */
	readonly maxBase64Size: number
	/** The raw size to shrink to: base64 grows bytes by a third, so this leaves room. */
	readonly targetRawSize: number
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBase64Size: 5 * 1024 * 1024,
	targetRawSize: 3.75 * 1024 * 1024,
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type FitResult =
	| { readonly ok: true; readonly data: Buffer; readonly mediaType: ImageMediaType }
	| { readonly ok: false; readonly message: string }

/** The part of the image library this module uses; tests supply a fake. */
export interface SharpPipeline {
	metadata(): Promise<{ width?: number; height?: number; orientation?: number; pages?: number }>
	/** Apply the EXIF orientation to the pixels and drop the tag. */
	rotate(): SharpPipeline
	resize(
		width: number,
		height?: number,
		options?: { fit?: 'inside'; withoutEnlargement?: boolean },
	): SharpPipeline
	flatten(options: { background: string }): SharpPipeline
	png(options?: { compressionLevel?: number; palette?: boolean }): SharpPipeline
	jpeg(options?: { quality?: number }): SharpPipeline
	webp(options?: { quality?: number }): SharpPipeline
	gif(): SharpPipeline
	toBuffer(): Promise<Buffer>
}
export type SharpFactory = (input: Buffer) => SharpPipeline

export interface FitDeps {
	/** Resolves the image library, or `null` when it is not installed. */
	readonly loadSharp?: () => Promise<SharpFactory | null>
	readonly limits?: ImageLimits
}

let sharpOnce: Promise<SharpFactory | null> | undefined

/** Load `sharp` once, on first need. A missing or unloadable library is `null`. */
export function loadSharp(): Promise<SharpFactory | null> {
	sharpOnce ??= (async () => {
		try {
			// A variable specifier: the library is optional, so neither the type
			// checker nor the bundler is told it will be there.
			const name = 'sharp'
			const mod = (await import(name)) as { default?: unknown }
			const factory = (mod.default ?? mod) as SharpFactory
			return typeof factory === 'function' ? factory : null
		} catch {
			return null
		}
	})()
	return sharpOnce
}

const MESSAGE_TOO_LARGE =
	'This image is too large to attach and image resizing is unavailable. Save it smaller, or paste a path to a smaller file.'
const MESSAGE_CANNOT_SHRINK =
	'This image is too large to attach, even after shrinking it. Save a smaller copy and paste its path.'
const MESSAGE_FORMAT_NEEDS_LIBRARY =
	'This image format needs image processing, which is unavailable here. Save it as PNG or JPEG and paste its path.'
const MESSAGE_ANIMATED =
	'This animated image is too large to attach, and shrinking it would keep only its first frame. Save a smaller copy and paste its path.'
const MESSAGE_NOT_AN_IMAGE = 'That is not an image this tool can attach (PNG, JPEG, GIF or WebP).'
const MESSAGE_EMPTY = 'That image file is empty.'

export type ImageFormat = ImageMediaType | 'image/bmp'

/** The format by leading bytes, or `null` for anything not recognised. */
export function sniffImageFormat(bytes: Buffer): ImageFormat | null {
	if (bytes.length < 12) return null
	if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png'
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
	if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
	if (
		bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
		bytes.subarray(8, 12).toString('latin1') === 'WEBP'
	) {
		return 'image/webp'
	}
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
	return null
}

/** Width and height read from the file's own header, or `null` when they cannot be. */
export function headerDimensions(
	bytes: Buffer,
	format: ImageFormat,
): { width: number; height: number } | null {
	const valid = (width: number, height: number) =>
		width > 0 && height > 0 ? { width, height } : null
	try {
		switch (format) {
			case 'image/png':
				return bytes.length >= 24 ? valid(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) : null
			case 'image/gif':
				return valid(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
			case 'image/bmp':
				return valid(bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22)))
			case 'image/jpeg': {
				let offset = 2
				while (offset + 9 < bytes.length) {
					if (bytes[offset] !== 0xff) return null
					const marker = bytes[offset + 1] ?? 0
					if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
						offset += 2
						continue
					}
					const length = bytes.readUInt16BE(offset + 2)
					const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
					if (isFrame) return valid(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5))
					offset += 2 + length
				}
				return null
			}
			case 'image/webp': {
				const kind = bytes.subarray(12, 16).toString('latin1')
				if (kind === 'VP8 ') {
					return valid(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
				}
				if (kind === 'VP8L') {
					const bits = bytes.readUInt32LE(21)
					return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
				}
				if (kind === 'VP8X') {
					return valid(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
				}
				return null
			}
		}
	} catch {
		return null
	}
}

/** Image tokens a model spends on a picture: 28 px patches. For diagnostics only. */
export function imageTokenCost(width: number, height: number): number {
	return Math.ceil(width / 28) * Math.ceil(height / 28)
}

function withinDimensions(size: { width: number; height: number }, limits: ImageLimits): boolean {
	return size.width <= limits.maxWidth && size.height <= limits.maxHeight
}

/**
 * Fit an image to the limits.
 *
 * PNG, JPEG, GIF and WebP inside the limits come back unchanged. Anything
 * else is converted to PNG first. An image too wide or tall is scaled to fit
 * inside, never enlarged; one still too heavy is tried as a palette PNG, then
 * as JPEG at quality 80, 60, 40 and 20, and last as a 1000 px wide JPEG at
 * quality 20.
 */
export async function fitImage(input: Buffer, deps: FitDeps = {}): Promise<FitResult> {
	const limits = deps.limits ?? DEFAULT_IMAGE_LIMITS
	if (input.length === 0) return { ok: false, message: MESSAGE_EMPTY }
	const format = sniffImageFormat(input)
	if (format === null) return { ok: false, message: MESSAGE_NOT_AN_IMAGE }

	// The common case needs no library: the file's own header says it is inside
	// the limits, so it is attached as it is and the library is never loaded.
	if (format !== 'image/bmp' && input.length <= limits.targetRawSize) {
		const quick = headerDimensions(input, format)
		if (quick !== null && withinDimensions(quick, limits)) {
			return { ok: true, data: input, mediaType: format }
		}
	}

	const sharp = await (deps.loadSharp ?? loadSharp)()
	if (sharp === null) return fitWithoutLibrary(input, format, limits)

	try {
		let bytes = input
		let current: ImageMediaType
		if (format === 'image/bmp') {
			bytes = await sharp(input).png().toBuffer()
			current = 'image/png'
		} else {
			current = format
		}
		const meta = await sharp(bytes).metadata()
		// An orientation of 5 to 8 turns the picture a quarter, so its shown
		// width is the stored height.
		const turned = (meta.orientation ?? 1) >= 5
		const size =
			meta.width && meta.height
				? turned
					? { width: meta.height, height: meta.width }
					: { width: meta.width, height: meta.height }
				: headerDimensions(bytes, current)
		if (bytes.length <= limits.targetRawSize && (!size || withinDimensions(size, limits))) {
			return { ok: true, data: bytes, mediaType: current }
		}

		// Only the first frame would survive any step below.
		if (current === 'image/gif' && (meta.pages ?? 1) > 1) {
			return { ok: false, message: MESSAGE_ANIMATED }
		}

		const fits = (data: Buffer): boolean => data.length <= limits.targetRawSize
		let resized = bytes
		if (size && !withinDimensions(size, limits)) {
			const scaled = sharp(bytes).rotate().resize(limits.maxWidth, limits.maxHeight, {
				fit: 'inside',
				withoutEnlargement: true,
			})
			resized = await encodeAs(scaled, current).toBuffer()
			if (fits(resized)) return { ok: true, data: resized, mediaType: current }
		}

		const base = (): SharpPipeline => sharp(resized).rotate()
		const palette = await base().png({ compressionLevel: 9, palette: true }).toBuffer()
		if (fits(palette)) return { ok: true, data: palette, mediaType: 'image/png' }
		for (const quality of [80, 60, 40, 20]) {
			const jpeg = await base().flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer()
			if (fits(jpeg)) return { ok: true, data: jpeg, mediaType: 'image/jpeg' }
		}
		const narrow = await sharp(resized)
			.rotate()
			.resize(1000, undefined, { fit: 'inside', withoutEnlargement: true })
			.flatten({ background: '#ffffff' })
			.jpeg({ quality: 20 })
			.toBuffer()
		if (narrow.length * (4 / 3) <= limits.maxBase64Size) {
			return { ok: true, data: narrow, mediaType: 'image/jpeg' }
		}
		return { ok: false, message: MESSAGE_CANNOT_SHRINK }
	} catch {
		// The library could not read it. A small file whose header says it is
		// inside the limits still goes through; the provider is the judge of
		// whether it decodes.
		return fitWithoutLibrary(input, format, limits)
	}
}

function encodeAs(pipeline: SharpPipeline, mediaType: ImageMediaType): SharpPipeline {
	switch (mediaType) {
		case 'image/png':
			return pipeline.png({ compressionLevel: 9 })
		case 'image/jpeg':
			return pipeline.jpeg({ quality: 90 })
		case 'image/webp':
			return pipeline.webp({ quality: 90 })
		case 'image/gif':
			return pipeline.gif()
	}
}

/** What can be decided from the file alone: pass it if it is clearly inside the limits. */
function fitWithoutLibrary(input: Buffer, format: ImageFormat, limits: ImageLimits): FitResult {
	if (format === 'image/bmp') return { ok: false, message: MESSAGE_FORMAT_NEEDS_LIBRARY }
	const size = headerDimensions(input, format)
	if (size !== null) {
		const heavy = Math.ceil((input.length * 4) / 3) > limits.maxBase64Size
		return withinDimensions(size, limits) && !heavy
			? { ok: true, data: input, mediaType: format }
			: { ok: false, message: MESSAGE_TOO_LARGE }
	}
	// Dimensions that cannot be read leave only the byte count to judge by.
	return input.length <= limits.targetRawSize
		? { ok: true, data: input, mediaType: format }
		: { ok: false, message: MESSAGE_TOO_LARGE }
}
