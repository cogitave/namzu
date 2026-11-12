/**
 * The faces theme.css ships, as the strings `document.fonts.load` takes. The terminal measures its
 * cells once when it opens, and the title fitter measures with a canvas: both must see the real
 * face, not the platform's stand-in, so they wait for these.
 */
export const SANS_FACE = '400 1em "Geist"'
export const SANS_ITALIC_FACE = 'italic 400 1em "Geist"'
export const MONO_FACE = '400 1em "Geist Mono"'

/** The slice of `document.fonts` this needs. */
export interface FaceLoader {
	load(font: string, text?: string): Promise<unknown>
	readonly ready: Promise<unknown>
}

/**
 * Resolves when the given faces are loaded and the document has no font still loading. It never
 * rejects: a face that cannot load leaves the fallback in place, and the caller measures that.
 */
export function facesReady(
	fonts: FaceLoader | undefined,
	faces: readonly string[] = [SANS_FACE, SANS_ITALIC_FACE, MONO_FACE],
): Promise<void> {
	if (!fonts) return Promise.resolve()
	return Promise.all(faces.map((face) => fonts.load(face)))
		.then(() => fonts.ready)
		.then(
			() => undefined,
			() => undefined,
		)
}

let monoReady: Promise<void> | undefined

/** The mono face, ready; one promise for the whole window. */
export function monoFaceReady(): Promise<void> {
	monoReady ??= facesReady(typeof document === 'undefined' ? undefined : document.fonts, [
		MONO_FACE,
	])
	return monoReady
}
