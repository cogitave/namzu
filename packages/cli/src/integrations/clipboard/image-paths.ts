/**
 * Image files named by a paste: a path typed into the terminal, or a file
 * dragged onto it. Terminals insert such a drop as a (usually quoted) path,
 * so the paste handler asks here first whether the whole paste is nothing but
 * paths to images, and attaches them if so.
 *
 * All or nothing: if any piece is not an image we can read, the caller keeps
 * the paste as ordinary text, so a paste is never half consumed.
 */

import { readFile, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { type FitResult, fitImage, sniffImageFormat } from './image-fit.js'
import type { ClipboardImage } from './image.js'
import { type PathEnvironment, windowsPathToWsl, wslSharePathToLinux } from './wsl.js'

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i
const MAX_PIECES = 16
const MAX_PIECE_LENGTH = 4096
/** Raw bytes above this are left as text; the provider would refuse them anyway. */
export const MAX_IMAGE_FILE_BYTES = 64 * 1024 * 1024

/** Split a paste into the pieces that could each be one path. */
function pieces(text: string): string[] {
	return text
		.split(/\r?\n/)
		.flatMap((line) => line.split(/ (?=["']?(?:\/|[A-Za-z]:\\|\\\\))/))
		.map((piece) => piece.trim())
		.filter((piece) => piece.length > 0)
}

function unquote(piece: string): string {
	const match = /^(["'])(.*)\1$/.exec(piece)
	return match ? (match[2] ?? '') : piece
}

/**
 * The absolute local paths a paste names, or `null` when the paste is not
 * made only of image paths. Windows forms are converted when on WSL.
 */
export function parsePastedImagePaths(text: string, env: PathEnvironment): string[] | null {
	const parts = pieces(text)
	if (parts.length === 0 || parts.length > MAX_PIECES) return null
	const out: string[] = []
	for (const part of parts) {
		if (part.length > MAX_PIECE_LENGTH) return null
		let path = unquote(part)
		const windowsForm = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)
		if (windowsForm && env.windows) {
			if (!win32.isAbsolute(path) || !IMAGE_EXTENSION.test(path)) return null
			out.push(path)
			continue
		}
		if (windowsForm) {
			if (!env.wsl) return null
			const converted = path.startsWith('\\\\')
				? wslSharePathToLinux(path, env.distro)
				: windowsPathToWsl(path, env.mountRoot)
			if (converted === undefined) return null
			path = converted
		} else {
			path = path.replace(/\\(.)/g, '$1')
		}
		if (!path.startsWith('/') || !IMAGE_EXTENSION.test(path)) return null
		out.push(path)
	}
	return out
}

export interface ImageFileDeps {
	readonly stat?: (path: string) => Promise<{ size: number; isFile(): boolean }>
	readonly readFile?: (path: string) => Promise<Buffer>
	/**
	 * Whether the permission rules let the CLI read this path: `null` when it
	 * may, otherwise a plain sentence saying why not. Absent means it may.
	 */
	readonly mayRead?: (path: string) => Promise<string | null>
	/** Brings an image inside the provider's limits; the default uses `sharp` when present. */
	readonly fit?: (bytes: Buffer) => Promise<FitResult>
}

export type ImageFilesResult =
	/** Every path was an image, fitted and ready. */
	| { readonly kind: 'images'; readonly images: ClipboardImage[] }
	/** A path is an image the operator should hear about: not allowed, or too large to shrink. */
	| { readonly kind: 'refused'; readonly message: string }
	/** Not (all) readable images: the paste stays ordinary text. */
	| { readonly kind: 'text' }

/**
 * Read every path as an image. All or nothing: one path that is missing,
 * empty, too large to read, or not an image by its leading bytes leaves the
 * paste as text, and one the permission rules refuse (or whose image cannot
 * be brought inside the provider's limits) is reported with the reason.
 */
export async function loadImageFiles(
	paths: readonly string[],
	deps: ImageFileDeps = {},
): Promise<ImageFilesResult> {
	const statFile = deps.stat ?? ((path: string) => stat(path))
	const read = deps.readFile ?? ((path: string) => readFile(path))
	const fit = deps.fit ?? ((bytes: Buffer) => fitImage(bytes))
	const images: ClipboardImage[] = []
	for (const path of paths) {
		if (deps.mayRead) {
			const refusal = await deps.mayRead(path)
			if (refusal !== null) return { kind: 'refused', message: refusal }
		}
		try {
			const info = await statFile(path)
			if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_FILE_BYTES) {
				return { kind: 'text' }
			}
			const bytes = await read(path)
			if (sniffImageFormat(bytes) === null) return { kind: 'text' }
			const fitted = await fit(bytes)
			if (!fitted.ok) return { kind: 'refused', message: fitted.message }
			images.push({
				data: fitted.data.toString('base64'),
				mediaType: fitted.mediaType,
				filename: win32.basename(path),
			})
		} catch {
			return { kind: 'text' }
		}
	}
	return { kind: 'images', images }
}
