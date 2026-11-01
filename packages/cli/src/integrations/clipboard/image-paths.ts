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

function mediaTypeOf(bytes: Buffer): ClipboardImage['mediaType'] | null {
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
	return null
}

export interface ImageFileDeps {
	readonly stat?: (path: string) => Promise<{ size: number; isFile(): boolean }>
	readonly readFile?: (path: string) => Promise<Buffer>
	/** Whether the permission rules let the CLI read this path; absent means yes. */
	readonly mayRead?: (path: string) => boolean
}

/**
 * Read every path as an image. `null` when any one is missing, empty, too
 * large, not an image by its leading bytes, or not allowed to be read.
 */
export async function loadImageFiles(
	paths: readonly string[],
	deps: ImageFileDeps = {},
): Promise<ClipboardImage[] | null> {
	const statFile = deps.stat ?? ((path: string) => stat(path))
	const read = deps.readFile ?? ((path: string) => readFile(path))
	const images: ClipboardImage[] = []
	for (const path of paths) {
		if (deps.mayRead && !deps.mayRead(path)) return null
		try {
			const info = await statFile(path)
			if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_FILE_BYTES) return null
			const bytes = await read(path)
			const mediaType = mediaTypeOf(bytes)
			if (mediaType === null) return null
			images.push({ data: bytes.toString('base64'), mediaType, filename: win32.basename(path) })
		} catch {
			return null
		}
	}
	return images
}
